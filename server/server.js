import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
import connectDB from "./configs/db.js";

const app = express();
const PORT = process.env.PORT || 4000;
await connectDB();

// Allow multiple origins
const allowedOrigins = ["http://localhost:5173"]; 

// Middleware configuration
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: allowedOrigins, credentials: true }));

app.get("/", (req, res) => {
  res.send("API is working");
});

app.listen(PORT, () => {
  console.log(`server is running on http://localhost:${PORT}`);
});
