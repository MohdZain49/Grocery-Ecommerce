import Address from "../models/Address.js";

// Add address : /api/address/add
export const addAddress = async (req, res) => {
  try {
    const { userId } = req;
    const { address } = req.body;
    await Address.create({ ...address, userId });
    res.json({ success: true, message: "Address added successfully" });
  } catch (error) {
    res.json({
      success: false,
      message: error.message,
    });
  }
};

// Get address : /api/address/get
export const getAddress = async (req, res) => {
  try {
    const { userId } = req;
    const addresses = await Address.find({ userId });
    res.json({ success: true, addresses });
  } catch (error) {
    console.log(error.message);
    res.json({
      success: false,
      message: error.message,
    });
  }
};
