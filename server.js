
require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE || "product_app";

if (!uri) {
  throw new Error("Thiếu biến môi trường MONGODB_URI");
}

const client = new MongoClient(uri);
let db;
let products;

// Chuyển chuỗi thành regex an toàn để tìm kiếm
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Kiểm tra kết nối
app.get("/api/health", async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error.name);
    res.status(503).json({
      status: "error",
      database: "unavailable"
    });
  }
});

// Lấy danh sách hoặc tìm kiếm sản phẩm
app.get("/api/products", async (req, res) => {
  try {
    const keyword = String(req.query.search || "").trim();
    const filter = {};

    if (keyword) {
      const pattern = escapeRegex(keyword);
      filter.$or = [
        { product_code: { $regex: pattern, $options: "i" } },
        { name: { $regex: pattern, $options: "i" } }
      ];
    }

    const rows = await products
      .find(filter)
      .sort({ _id: -1 })
      .toArray();

    // Giữ trường id để tương thích với frontend cũ
    res.json(rows.map(({ _id, ...item }) => ({
      ...item,
      id: _id.toString()
    })));
  } catch (error) {
    console.error("Product search failed:", error.name);
    res.status(500).json({
      message: "Không thể tải sản phẩm."
    });
  }
});

// Thêm sản phẩm
app.post("/api/products", async (req, res) => {
  try {
    const { product_code, name, price, quantity } = req.body;

    const code = String(product_code || "").trim();
    const productName = String(name || "").trim();
    const productPrice = Number(price);
    const productQuantity = Number(quantity);

    if (
      !code ||
      !productName ||
      !Number.isFinite(productPrice) ||
      productPrice <= 0 ||
      !Number.isInteger(productQuantity) ||
      productQuantity < 0
    ) {
      return res.status(400).json({
        message: "Vui lòng nhập mã, tên, giá hợp lệ và số lượng không âm."
      });
    }

    const result = await products.insertOne({
      product_code: code,
      name: productName,
      price: productPrice,
      quantity: productQuantity,
      created_at: new Date()
    });

    res.status(201).json({
      message: "Thêm sản phẩm thành công.",
      id: result.insertedId.toString()
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "Mã sản phẩm đã tồn tại."
      });
    }

    console.error("Product insert failed:", error.name);
    res.status(500).json({
      message: "Không thể thêm sản phẩm."
    });
  }
});

// Kết nối trước khi mở server
async function startServer() {
  try {
    await client.connect();

    db = client.db(databaseName);
    products = db.collection("products");

    await products.createIndex(
      { product_code: 1 },
      { unique: true }
    );

    await db.command({ ping: 1 });

    console.log("MongoDB connected; products collection is ready.");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error(
      "Application startup failed:",
      error.code || error.name || "STARTUP_ERROR"
    );
    await client.close().catch(() => {});
    process.exit(1);
  }
}

startServer();
