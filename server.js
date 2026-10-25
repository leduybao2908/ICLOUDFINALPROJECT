
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: Number(process.env.MYSQLPORT),
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,

  ssl: {
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    ca: process.env.MYSQL_SSL_CA
      ? require("fs").readFileSync(process.env.MYSQL_SSL_CA, "utf8")
      : undefined
  },

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Tạo bảng nếu chưa tồn tại
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      price DECIMAL(15, 2) NOT NULL,
      quantity INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("MySQL connected; products table is ready.");
}

// Kiểm tra trạng thái máy chủ
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error.code || "DB_ERROR");
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

    let sql = `
      SELECT id, product_code, name, price, quantity, created_at
      FROM products
    `;
    let params = [];

    if (keyword) {
      sql += `
        WHERE product_code LIKE ? OR name LIKE ?
      `;
      const pattern = `%${keyword}%`;
      params = [pattern, pattern];
    }

    sql += " ORDER BY id DESC";

    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("Product search failed:", error.code || "DB_ERROR");
    res.status(500).json({ message: "Không thể tải sản phẩm." });
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

    const [result] = await pool.execute(
      `INSERT INTO products
       (product_code, name, price, quantity)
       VALUES (?, ?, ?, ?)`,
      [code, productName, productPrice, productQuantity]
    );

    res.status(201).json({
      message: "Thêm sản phẩm thành công.",
      id: result.insertId
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "Mã sản phẩm đã tồn tại."
      });
    }

    console.error("Product insert failed:", error.code || "DB_ERROR");
    res.status(500).json({ message: "Không thể thêm sản phẩm." });
  }
});

// Khởi động sau khi kết nối và tạo bảng thành công
async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error(
      "Application startup failed:",
      error.code || "STARTUP_ERROR"
    );
    process.exit(1);
  }
}

startServer();
