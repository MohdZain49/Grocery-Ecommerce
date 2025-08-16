import Order from "../models/Order.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import mongoose from "mongoose";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" });

/**
 * Helpers
 */
const cents = (amount) => Math.round(amount * 100); // rupees/dollars -> cents
const fromCents = (c) => c / 100;

/**
 * Place COD order
 * POST /api/order/cod
 */
export const placeOrderCOD = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { userId } = req; // assume set by auth middleware
    const { items, address } = req.body;

    if (!address || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid order data" });
    }

    // Start transaction so we atomically check & decrement stock and create order
    session.startTransaction();

    // Fetch all products in parallel (and lock via the docs we update)
    const productIds = items.map((it) => it.product);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);

    // map id -> product
    const prodMap = new Map(products.map((p) => [p._id.toString(), p]));

    // validate and compute amount in cents
    let totalCents = 0;
    for (const it of items) {
      const pid = it.product;
      const qty = Number(it.quantity) || 0;
      const product = prodMap.get(pid);
      if (!product) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: `Product not found: ${pid}` });
      }
      if (product.stock < qty) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: `Insufficient stock for ${product.name}` });
      }
      totalCents += cents(product.offerPrice) * qty;
    }

    // apply 2% tax to total
    totalCents = Math.round(totalCents * 1.02);

    // decrement stock for each product (atomic update)
    for (const it of items) {
      const pid = it.product;
      const qty = Number(it.quantity) || 0;
      await Product.updateOne(
        { _id: pid, stock: { $gte: qty } },
        { $inc: { stock: -qty } }
      ).session(session);
      // optional: check matchedCount to ensure no race condition (double-check)
    }

    // create order (amount stored in normal units, e.g. dollars/INR)
    const order = await Order.create(
      [
        {
          userId,
          items,
          amount: fromCents(totalCents),
          address,
          paymentType: "COD",
          isPaid: false,
        },
      ],
      { session }
    );

    // clear user's cart
    await User.findByIdAndUpdate(userId, { cartItems: {} }).session(session);

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({ success: true, message: "Order placed successfully", orderId: order[0]._id });
  } catch (error) {
    await session.abortTransaction().catch(() => { });
    session.endSession();
    console.error("placeOrderCOD error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Place Stripe order (create checkout session). We create an order record (not yet paid).
 * POST /api/order/stripe
 */
export const placeOrderStripe = async (req, res) => {
  try {
    const { userId } = req;
    const { items, address } = req.body;
    const origin = req.headers.origin || req.headers.referer;

    if (!address || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid order data" });
    }

    // Fetch products from DB
    const productIds = items.map((it) => it.product);
    const products = await Product.find({ _id: { $in: productIds } });

    const prodMap = new Map(products.map((p) => [p._id.toString(), p]));

    // Build line items and compute amount in cents
    let totalCents = 0;
    const line_items = [];

    for (const it of items) {
      const pid = it.product;
      const qty = Number(it.quantity) || 0;
      const product = prodMap.get(pid);
      if (!product) {
        return res.status(404).json({ success: false, message: `Product not found: ${pid}` });
      }
      if (product.stock < qty) {
        return res.status(400).json({ success: false, message: `Insufficient stock for ${product.name}` });
      }

      const priceCents = cents(product.offerPrice);
      totalCents += priceCents * qty;

      // To keep Stripe total consistent with our tax logic, add tax per-item here:
      const unitWithTax = Math.round(priceCents * 1.02);

      line_items.push({
        price_data: {
          currency: "usd", // change if needed
          product_data: { name: product.name },
          unit_amount: unitWithTax, // in cents
        },
        quantity: qty,
      });
    }

    // totalCents with tax (global) will be:
    const computedTotalCents = Math.round(totalCents * 1.02);

    // Now create an Order record in DB (not paid yet). We'll mark paid in webhook.
    const order = await Order.create({
      userId,
      items,
      amount: fromCents(computedTotalCents),
      address,
      paymentType: "Online",
      isPaid: false,
    });

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items,
      mode: "payment",
      success_url: `${origin}/loader?next=my-orders`,
      cancel_url: `${origin}/cart`,
      metadata: {
        orderId: order._id.toString(),
        userId,
      },
    });

    return res.status(200).json({ success: true, url: session.url });
  } catch (error) {
    console.error("placeOrderStripe error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Stripe webhook handler (must receive raw body).
 * POST /webhook/stripe  (or /stripe)
 */
export const stripeWebhooks = async (req, res) => {
  // IMPORTANT: this route MUST use express.raw({ type: "application/json" }) middleware
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    // req.rawBody must be the raw payload buffer/string provided by express.raw middleware
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook constructEvent error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle relevant event types
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      const { orderId, userId } = session.metadata || {};

      if (!orderId || !userId) {
        console.warn("Webhook session missing metadata:", session.id);
      } else {
        // Mark order paid and clear cart and decrement stock
        const order = await Order.findById(orderId);
        if (order) {
          // Mark paid
          order.isPaid = true;
          await order.save();

          // Clear user's cart
          await User.findByIdAndUpdate(userId, { cartItems: {} });

          // Decrement stock for items (best-effort)
          for (const it of order.items) {
            await Product.updateOne({ _id: it.product }, { $inc: { stock: -it.quantity } });
          }
        } else {
          console.warn("Order not found for webhook orderId:", orderId);
        }
      }
    } else if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
      // Payment failed -> delete the order (or mark as failed)
      const session = event.data.object;
      const { orderId } = session.metadata || {};
      if (orderId) {
        await Order.findByIdAndDelete(orderId);
      }
    } else {
      // Other events we don't act on here
      console.log("Unhandled Stripe event:", event.type);
    }
  } catch (err) {
    console.error("Error handling webhook event:", err);
    // Still return 200 to Stripe? If you return non-2xx, Stripe will retry. You may prefer 500 to force a retry.
    return res.status(500).send();
  }

  return res.json({ received: true });
};

/**
 * Get user orders
 * GET /api/order/user
 */
export const getUserOrders = async (req, res) => {
  try {
    const { userId } = req;
    const orders = await Order.find({
      userId,
      $or: [{ paymentType: "COD" }, { isPaid: true }],
    })
      .populate("items.product")
      .populate("address")
      .sort({ createdAt: -1 });

    return res.json({ success: true, orders });
  } catch (err) {
    console.error("getUserOrders:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Get all orders (admin/seller)
 * GET /api/order/seller
 * NOTE: protect this route with auth + role middleware
 */
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      $or: [{ paymentType: "COD" }, { isPaid: true }],
    })
      .populate("items.product")
      .populate("address")
      .sort({ createdAt: -1 });

    return res.json({ success: true, orders });
  } catch (err) {
    console.error("getAllOrders:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
