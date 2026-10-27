require("dotenv").config();
const dns = require("node:dns");

dns.setServers(["8.8.8.8", "1.1.1.1"]);
const express = require("express");
const { MongoClient } = require("mongodb");
const path = require("path");
const crypto = require("node:crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE || "product_app";

if (!uri) {
  throw new Error("Thiếu biến môi trường MONGODB_URI trong file .env");
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000,
});

let db;
let products;
let users;
let counters;

// Helper: wrap async route handlers
function wrap(fn) {
  return function (req, res, next) {
    fn(req, res, next).catch((err) => {
      const status = err.status || 500;
      res.status(status).json({ message: err.message || "Lỗi server." });
    });
  };
}

// Helper: throw HTTP error
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Helper: next sequential ID
async function nextId(name) {
  const result = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return result.seq || result.value?.seq || 1;
}

// Helper: hash password using Node.js crypto (PBKDF2)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

// Helper: verify password
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, originalHash] = stored.split(":");
  if (!salt || !originalHash) return false;
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return hash === originalHash;
}

// Simple in-memory active tokens (or base64 encoded JSON tokens for simplicity)
const activeTokens = new Map();

function generateToken(user) {
  const token = crypto.randomBytes(32).toString("hex");
  activeTokens.set(token, { id: user.id, username: user.username, role: user.role });
  return token;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ message: "Chưa đăng nhập hoặc token hết hạn." });
  }
  req.user = activeTokens.get(token);
  next();
}

// Chuyển chuỗi thành regex an toàn để tìm kiếm
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Kiểm tra kết nối MongoDB
app.get("/api/health", async (req, res) => {
  try {
    await db.command({ ping: 1 });

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      status: "error",
      database: "unavailable",
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
        {
          product_code: {
            $regex: pattern,
            $options: "i",
          },
        },
        {
          name: {
            $regex: pattern,
            $options: "i",
          },
        },
      ];
    }

    const rows = await products
      .find(filter)
      .sort({ _id: -1 })
      .toArray();

    // Giữ trường id để tương thích với frontend cũ
    res.json(
      rows.map(({ _id, ...item }) => ({
        ...item,
        id: _id.toString(),
      }))
    );
  } catch (error) {
    console.error("Product search failed:", error.message);

    res.status(500).json({
      message: "Không thể tải sản phẩm.",
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
        message:
          "Vui lòng nhập mã, tên, giá hợp lệ và số lượng không âm.",
      });
    }

    const result = await products.insertOne({
      product_code: code,
      name: productName,
      price: productPrice,
      quantity: productQuantity,
      created_at: new Date(),
    });

    res.status(201).json({
      message: "Thêm sản phẩm thành công.",
      id: result.insertedId.toString(),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "Mã sản phẩm đã tồn tại.",
      });
    }

    console.error("Product insert failed:", error.message);

    res.status(500).json({
      message: "Không thể thêm sản phẩm.",
    });
  }
});

// Đăng ký người dùng
app.post("/api/register", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim().slice(0, 50);
  const fullName = String(req.body.full_name || "").trim().slice(0, 100);
  const password = String(req.body.password || "");
  if (!username || !fullName || password.length < 6) {
    throw httpError(400, "Nhập đủ họ tên, tên đăng nhập và mật khẩu từ 6 ký tự.");
  }
  if (await users.findOne({ username })) {
    throw httpError(409, "Tên đăng nhập đã tồn tại.");
  }
  const userDoc = {
    id: await nextId("users"),
    username,
    full_name: fullName,
    password_hash: hashPassword(password),
    role: "staff",
    created_at: new Date(),
  };
  await users.insertOne(userDoc);
  res.status(201).json({ message: "Đăng ký thành công." });
}));

// Đăng nhập
app.post("/api/login", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = await users.findOne({ username });
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, "Sai tên đăng nhập hoặc mật khẩu.");
  }
  const token = generateToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
    },
  });
}));

// Lấy thông tin user hiện tại
app.get("/api/me", authMiddleware, wrap(async (req, res) => {
  const user = await users.findOne({ id: req.user.id });
  if (!user) throw httpError(404, "Không tìm thấy người dùng.");
  res.json({
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
  });
}));

// Thống kê dashboard
app.get("/api/stats", authMiddleware, wrap(async (req, res) => {
  const allProducts = await products.find({}).toArray();
  const totalStock = allProducts.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  const lowStock = allProducts.filter((p) => Number(p.quantity || 0) < 5);

  // Generate 7 days labels
  const last7days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7days.push({
      label: d.toLocaleDateString("vi-VN", { weekday: "short", day: "numeric", month: "numeric" }),
      total: 0,
    });
  }

  res.json({
    revenue: 0,
    todayRevenue: 0,
    orders: 0,
    products: allProducts.length,
    stock: totalStock,
    last7days,
    topProducts: [],
    lowStock: lowStock.map(({ _id, ...p }) => ({ ...p, id: _id.toString() })),
  });
}));

// Quản lý users (admin)
app.get("/api/users", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") throw httpError(403, "Không có quyền.");
  const allUsers = await users.find({}, { projection: { password_hash: 0 } }).toArray();
  res.json(allUsers.map(({ _id, ...u }) => ({ ...u, id: u.id || _id.toString() })));
}));

app.post("/api/users", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") throw httpError(403, "Không có quyền.");
  const { username, full_name, password, role } = req.body;
  if (!username || !full_name || !password) throw httpError(400, "Thiếu thông tin.");
  if (await users.findOne({ username })) throw httpError(409, "Tên đăng nhập đã tồn tại.");
  await users.insertOne({
    id: await nextId("users"),
    username: String(username).trim(),
    full_name: String(full_name).trim(),
    password_hash: hashPassword(password),
    role: role === "admin" ? "admin" : "staff",
    created_at: new Date(),
  });
  res.status(201).json({ message: "Tạo tài khoản thành công." });
}));

app.put("/api/users/:id", authMiddleware, wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (req.user.role !== "admin" && req.user.id !== targetId) {
    throw httpError(403, "Không có quyền.");
  }
  const updateData = {};
  if (req.body.role && req.user.role === "admin") {
    updateData.role = req.body.role;
  }
  if (req.body.password) {
    updateData.password_hash = hashPassword(req.body.password);
  }
  await users.updateOne({ id: targetId }, { $set: updateData });
  res.json({ message: "Cập nhật thành công." });
}));

app.delete("/api/users/:id", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") throw httpError(403, "Không có quyền.");
  const targetId = Number(req.params.id);
  if (req.user.id === targetId) throw httpError(400, "Không thể tự xóa tài khoản của chính mình.");
  await users.deleteOne({ id: targetId });
  res.json({ message: "Đã xóa tài khoản." });
}));
// Kết nối MongoDB trước khi mở server
async function startServer() {
  try {
    console.log("Đang kết nối MongoDB...");
    console.log("Database:", databaseName);

    await client.connect();

    db = client.db(databaseName);
    products = db.collection("products");
    users = db.collection("users");
    counters = db.collection("counters");

    await products.createIndex(
      { product_code: 1 },
      { unique: true }
    );

    await users.createIndex(
      { username: 1 },
      { unique: true }
    );

    await db.command({ ping: 1 });

    console.log("MongoDB connected successfully.");
    console.log("Products collection is ready.");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("\nApplication startup failed:");
    console.error("Error name:", error.name);
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);

    if (error.cause) {
      console.error("Error cause:", error.cause);
    }

    if (error.reason) {
      console.error("Server selection reason:", error.reason);
    }

    await client.close().catch(() => {});
    process.exitCode = 1;
  }
}

startServer();
