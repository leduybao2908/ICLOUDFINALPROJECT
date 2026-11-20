require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const crypto = require("node:crypto");
const XLSX = require("xlsx");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Railway MySQL connection pool
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: Number(process.env.MYSQLPORT || 3306),
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true
});

const ORDER_STATUSES = ["pending", "confirmed", "shipping", "completed", "cancelled"];
const PHONE_RE = /^[0-9+\s.-]{8,20}$/;

// Async error handler wrapper
function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) {
        console.error("API error:", err.code || err.message);
      }
      res.status(status).json({ message: err.message || "Internal server error." });
    });
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// PBKDF2 password hashing
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

// Verify password
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, originalHash] = stored.split(":");
  if (!salt || !originalHash) return false;
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  const original = Buffer.from(originalHash, "hex");
  const current = Buffer.from(hash, "hex");
  return original.length === current.length && crypto.timingSafeEqual(original, current);
}

// In-memory active tokens
const activeTokens = new Map();

function generateToken(user) {
  const token = crypto.randomBytes(32).toString("hex");
  activeTokens.set(token, { id: user.id, username: user.username, role: user.role });
  return token;
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ message: "Unauthorized: Please sign in or session has expired." });
  }
  try {
    const session = activeTokens.get(token);
    let rows = [];
    if (session.role === "admin") {
      [rows] = await pool.execute(
        "SELECT role, is_locked FROM admins WHERE id=? AND role='admin'",
        [session.id]
      );
    } else {
      [rows] = await pool.execute("SELECT role, is_locked FROM users WHERE id=?", [session.id]);
    }
    if (!rows[0] || rows[0].is_locked) {
      activeTokens.delete(token);
      return res.status(401).json({ message: "Account has been locked." });
    }
    req.user = { ...session, role: rows[0].role };
    next();
  } catch (error) {
    next(error);
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: You do not have permission to perform this action." });
    }
    next();
  };
}

// Database health check
app.get("/api/health", wrap(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", database: "connected" });
}));

// List and search products
// Customers only see active products and cannot see cost prices.
app.get("/api/products", authMiddleware, wrap(async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const keyword = String(req.query.search || "").trim();
  const fields = isAdmin
    ? "p.*"
    : "p.id,p.product_code,p.sku,p.name,p.image,p.category_id,p.brand_id,p.price,p.quantity,p.status,p.low_stock_threshold,p.created_at,p.import_date";
  let sql = `SELECT ${fields}, c.name AS category_name, b.name AS brand_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id WHERE 1=1`;
  const params = [];
  if (keyword) {
    sql += ` AND (p.product_code LIKE ? OR COALESCE(p.sku,'') LIKE ? OR p.name LIKE ?)`;
    const search = `%${keyword}%`;
    params.push(search, search, search);
  }
  if (req.query.category) { sql += " AND p.category_id = ?"; params.push(Number(req.query.category)); }
  if (req.query.brand) { sql += " AND p.brand_id = ?"; params.push(Number(req.query.brand)); }
  if (!isAdmin) {
    sql += " AND p.status = 'active'";
  } else if (req.query.status) {
    sql += " AND p.status = ?";
    params.push(String(req.query.status));
  }
  const sort = ({
    name_asc: "p.name ASC", name_desc: "p.name DESC",
    price_asc: "p.price ASC", price_desc: "p.price DESC",
    quantity_asc: "p.quantity ASC", quantity_desc: "p.quantity DESC",
    newest: "p.id DESC"
  })[req.query.sort] || "p.id DESC";
  sql += " ORDER BY " + sort;
  const [rows] = await pool.execute(sql, params);
  res.json(rows);
}));

// Add product
app.post("/api/products", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const { product_code, sku, name, category_id, brand_id, image, status,
    cost_price, price, quantity, low_stock_threshold, import_date } = req.body;
  const code = String(sku || product_code || "").trim();
  const productName = String(name || "").trim();
  const productPrice = Number(price);
  const productCost = Number(cost_price || 0);
  const productQuantity = Number(quantity);
  if (
    !code || !productName ||
    !Number.isFinite(productPrice) || productPrice <= 0 ||
    !Number.isInteger(productQuantity) || productQuantity < 0
  ) {
    throw httpError(400, "Please provide a valid SKU, product name, price, and quantity.");
  }
  try {
    const [result] = await pool.execute(
      `INSERT INTO products
       (product_code, sku, name, category_id, brand_id, image, cost_price, price,
        quantity, status, low_stock_threshold, import_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, code, productName, category_id || null, brand_id || null, image || null,
        productCost, productPrice, productQuantity, status === "inactive" ? "inactive" : "active",
        Number(low_stock_threshold || 5), import_date || null]
    );
    res.status(201).json({ message: "Product added successfully.", id: result.insertId });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw httpError(409, "Product code/SKU already exists.");
    throw error;
  }
}));

app.put("/api/products/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const quantity = Number(b.quantity);
  const price = Number(b.price);
  const cost = Number(b.cost_price || 0);
  if (!Number.isInteger(quantity) || quantity < 0 || !Number.isFinite(price) || price <= 0) {
    throw httpError(400, "Invalid selling price or quantity.");
  }
  await pool.execute(`
    UPDATE products SET product_code=?, sku=?, name=?, category_id=?, brand_id=?, image=?,
    cost_price=?, price=?, quantity=?, status=?, low_stock_threshold=?, import_date=? WHERE id=?`,
    [b.sku || b.product_code, b.sku || b.product_code, String(b.name || "").trim(),
      b.category_id || null, b.brand_id || null, b.image || null, cost, price, quantity,
      b.status === "inactive" ? "inactive" : "active", Number(b.low_stock_threshold || 5),
      b.import_date || null, id]
  );
  res.json({ message: "Product updated successfully." });
}));

app.delete("/api/products/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM products WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Product deleted successfully." });
}));

app.get("/api/categories", wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT c.id, c.name, c.created_at, COUNT(p.id) AS product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id, c.name, c.created_at
    ORDER BY c.name
  `);
  res.json(rows);
}));
app.post("/api/categories", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw httpError(400, "Category name cannot be empty.");
  await pool.execute("INSERT INTO categories (name) VALUES (?)", [name]);
  res.status(201).json({ message: "Category created successfully." });
}));
app.delete("/api/categories/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM categories WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Category deleted successfully." });
}));

app.get("/api/brands", wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT b.id, b.name, b.created_at, COUNT(p.id) AS product_count
    FROM brands b
    LEFT JOIN products p ON p.brand_id = b.id
    GROUP BY b.id, b.name, b.created_at
    ORDER BY b.name
  `);
  res.json(rows);
}));
app.post("/api/brands", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw httpError(400, "Brand name cannot be empty.");
  await pool.execute("INSERT INTO brands (name) VALUES (?)", [name]);
  res.status(201).json({ message: "Brand created successfully." });
}));
app.delete("/api/brands/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM brands WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Brand deleted successfully." });
}));

// Manual inventory movement (Stock In / Stock Out)
app.post("/api/inventory/movement", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const productId = Number(req.body.product_id);
  const type = req.body.type === "out" ? "out" : "in";
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
    throw httpError(400, "Invalid inventory movement information.");
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT quantity FROM products WHERE id=? FOR UPDATE", [productId]);
    if (!rows[0]) throw httpError(404, "Product not found.");
    const nextQuantity = type === "in" ? rows[0].quantity + quantity : rows[0].quantity - quantity;
    if (nextQuantity < 0) throw httpError(400, "Export quantity exceeds available stock.");
    await connection.execute("UPDATE products SET quantity=? WHERE id=?", [nextQuantity, productId]);
    await connection.execute(
      "INSERT INTO inventory_movements (product_id,type,quantity,note,user_id,actor_name) VALUES (?,?,?,?,?,?)",
      [productId, type, quantity, String(req.body.note || "").trim(), req.user.id, req.user.username]
    );
    await connection.commit();
    res.json({ message: type === "in" ? "Stock imported successfully." : "Stock exported successfully.", quantity: nextQuantity });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

app.get("/api/inventory/movements", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT m.*, p.name AS product_name, p.product_code,
           COALESCE(m.actor_name, u.full_name) AS user_name
    FROM inventory_movements m
    JOIN products p ON p.id=m.product_id
    LEFT JOIN users u ON u.id=m.user_id
    ORDER BY m.created_at DESC LIMIT 300
  `);
  res.json(rows);
}));

app.post("/api/products/import", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const workbook = XLSX.read(req.body.base64, { type: "base64" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  let imported = 0;
  for (const row of rows) {
    const code = String(row.SKU || row.sku || row["Mã SKU"] || row["Product Code"] || "").trim();
    const name = String(row["Product Name"] || row["Tên sản phẩm"] || row.name || "").trim();
    const price = Number(row["Selling Price"] || row["Giá bán"] || row.price || 0);
    const cost = Number(row["Cost Price"] || row["Giá nhập"] || row.cost_price || 0);
    const quantity = Number(row.Quantity || row["Số lượng"] || row.quantity || 0);
    if (!code || !name || !Number.isFinite(price) || price <= 0 || !Number.isInteger(quantity) || quantity < 0) continue;
    await pool.execute(`
      INSERT INTO products (product_code,sku,name,cost_price,price,quantity,status,low_stock_threshold)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE name=VALUES(name),cost_price=VALUES(cost_price),price=VALUES(price),quantity=VALUES(quantity)
    `, [code, code, name, cost, price, quantity, "active", 5]);
    imported++;
  }
  res.json({ message: `Imported ${imported} products successfully.`, imported });
}));

// Customer registration
app.post("/api/register", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim().slice(0, 50);
  const fullName = String(req.body.full_name || "").trim().slice(0, 100);
  const password = String(req.body.password || "");

  if (!username || !fullName || password.length < 6) {
    throw httpError(400, "Please provide full name, username, and a password of at least 6 characters.");
  }

  // Username must not conflict with admins
  const [adminDup] = await pool.execute("SELECT id FROM admins WHERE username=?", [username]);
  if (adminDup[0]) throw httpError(409, "Username already exists.");

  try {
    await pool.execute(
      "INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)",
      [username, fullName, hashPassword(password), "viewer"]
    );
    res.status(201).json({ message: "Registration successful." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw httpError(409, "Username already exists.");
    throw error;
  }
}));

// Sign in
app.post("/api/login", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const [adminRows] = await pool.execute(
    "SELECT id, username, full_name, password_hash, role, is_locked FROM admins WHERE username=?",
    [username]
  );
  if (adminRows[0]) {
    const admin = adminRows[0];
    if (!verifyPassword(password, admin.password_hash)) {
      throw httpError(401, "Invalid username or password.");
    }
    if (admin.is_locked) throw httpError(403, "Account has been locked.");
    const token = generateToken(admin);
    return res.json({
      token,
      user: { id: admin.id, username: admin.username, full_name: admin.full_name, role: "admin" }
    });
  }

  const [rows] = await pool.execute(
    "SELECT id, username, full_name, password_hash, role, is_locked FROM users WHERE username = ?",
    [username]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, "Invalid username or password.");
  }
  if (user.is_locked) throw httpError(403, "Account has been locked.");

  const token = generateToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role }
  });
}));

// Current user profile
app.get("/api/me", authMiddleware, wrap(async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const [rows] = await pool.execute(
    `SELECT id, username, full_name, phone, address, ${isAdmin ? "'admin'" : "role"} AS role
     FROM ${isAdmin ? "admins" : "users"} WHERE id=?`,
    [req.user.id]
  );
  if (!rows[0]) throw httpError(404, "User not found.");
  res.json(rows[0]);
}));

// Update personal profile
app.put("/api/profile", authMiddleware, wrap(async (req, res) => {
  const table = req.user.role === "admin" ? "admins" : "users";
  const fullName = String(req.body.full_name || "").trim().slice(0, 100);
  const phone = String(req.body.phone || "").trim().slice(0, 20);
  const address = String(req.body.address || "").trim().slice(0, 255);
  if (!fullName) throw httpError(400, "Full name cannot be empty.");
  if (phone && !PHONE_RE.test(phone)) throw httpError(400, "Invalid phone number format.");
  await pool.execute(
    `UPDATE ${table} SET full_name=?, phone=?, address=? WHERE id=?`,
    [fullName, phone || null, address || null, req.user.id]
  );
  res.json({ message: "Profile updated successfully." });
}));

// Change password
app.post("/api/profile/password", authMiddleware, wrap(async (req, res) => {
  const table = req.user.role === "admin" ? "admins" : "users";
  const current = String(req.body.current_password || "");
  const next = String(req.body.new_password || "");
  if (next.length < 6) throw httpError(400, "New password must be at least 6 characters.");
  const [rows] = await pool.execute(`SELECT password_hash FROM ${table} WHERE id=?`, [req.user.id]);
  if (!rows[0] || !verifyPassword(current, rows[0].password_hash)) {
    throw httpError(400, "Current password is incorrect.");
  }
  await pool.execute(`UPDATE ${table} SET password_hash=? WHERE id=?`, [hashPassword(next), req.user.id]);
  res.json({ message: "Password changed successfully." });
}));

// ---------- Orders ----------

// Cancel order and return items to stock (within transaction)
async function cancelOrderTx(connection, orderId, actor) {
  const [items] = await connection.execute(
    "SELECT product_id, quantity FROM order_items WHERE order_id=?",
    [orderId]
  );
  for (const item of items) {
    if (!item.product_id) continue;
    await connection.execute("UPDATE products SET quantity=quantity+? WHERE id=?", [item.quantity, item.product_id]);
    await connection.execute(
      "INSERT INTO inventory_movements (product_id,type,quantity,note,user_id,actor_name) VALUES (?,?,?,?,?,?)",
      [item.product_id, "in", item.quantity, `Restocked due to cancelled order #${orderId}`, actor.id, actor.username]
    );
  }
  await connection.execute("UPDATE orders SET status='cancelled' WHERE id=?", [orderId]);
}

// Customer checkout. Price and stock are verified on the server.
app.post("/api/orders", authMiddleware, requireRoles("viewer"), wrap(async (req, res) => {
  const b = req.body;
  const receiver = String(b.receiver_name || "").trim().slice(0, 100);
  const phone = String(b.phone || "").trim().slice(0, 20);
  const address = String(b.address || "").trim().slice(0, 255);
  const note = String(b.note || "").trim().slice(0, 255);
  if (!receiver || !PHONE_RE.test(phone) || !address) {
    throw httpError(400, "Please provide recipient name, valid phone number, and shipping address.");
  }

  const wanted = new Map();
  for (const item of Array.isArray(b.items) ? b.items : []) {
    const id = Number(item.product_id);
    const qty = Number(item.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0) {
      throw httpError(400, "Invalid order cart.");
    }
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  if (!wanted.size || wanted.size > 50) throw httpError(400, "Cart is empty or exceeds maximum limit of 50 items.");

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let total = 0;
    const lines = [];
    // Lock in ascending ID order to prevent deadlock
    for (const id of [...wanted.keys()].sort((a, c) => a - c)) {
      const qty = wanted.get(id);
      const [rows] = await connection.execute(
        "SELECT id, product_code, name, price, quantity, status FROM products WHERE id=? FOR UPDATE",
        [id]
      );
      const p = rows[0];
      if (!p || p.status !== "active") throw httpError(400, "One or more products are inactive or no longer available.");
      if (p.quantity < qty) throw httpError(400, `"${p.name}" only has ${p.quantity} items left in stock.`);
      total += p.price * qty;
      lines.push({ p, qty });
    }
    total = Math.round(total * 100) / 100;

    const [result] = await connection.execute(
      `INSERT INTO orders (user_id, customer_username, receiver_name, phone, address, note, total, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, req.user.username, receiver, phone, address, note || null, total]
    );
    const orderId = result.insertId;

    for (const { p, qty } of lines) {
      await connection.execute("UPDATE products SET quantity=quantity-? WHERE id=?", [qty, p.id]);
      await connection.execute(
        `INSERT INTO order_items (order_id, product_id, product_name, product_code, price, quantity)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, p.id, p.name, p.product_code, p.price, qty]
      );
      await connection.execute(
        "INSERT INTO inventory_movements (product_id,type,quantity,note,user_id,actor_name) VALUES (?,?,?,?,?,?)",
        [p.id, "out", qty, `Order #${orderId}`, req.user.id, req.user.username]
      );
    }
    await connection.commit();
    res.status(201).json({ message: `Order placed successfully. Order ID #${orderId}.`, id: orderId });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// List orders: customers view their own, admins view all
app.get("/api/orders", authMiddleware, wrap(async (req, res) => {
  const params = [];
  let sql = "SELECT * FROM orders WHERE 1=1";
  if (req.user.role !== "admin") {
    sql += " AND user_id=?";
    params.push(req.user.id);
  } else if (ORDER_STATUSES.includes(req.query.status)) {
    sql += " AND status=?";
    params.push(req.query.status);
  }
  sql += " ORDER BY id DESC LIMIT 200";
  const [orders] = await pool.execute(sql, params);
  if (orders.length) {
    const [items] = await pool.query(
      "SELECT * FROM order_items WHERE order_id IN (?) ORDER BY id",
      [orders.map((o) => o.id)]
    );
    for (const o of orders) o.items = items.filter((i) => i.order_id === o.id);
  }
  res.json(orders);
}));

// Customer cancels order while pending
app.post("/api/orders/:id/cancel", authMiddleware, requireRoles("viewer"), wrap(async (req, res) => {
  const orderId = Number(req.params.id);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT status FROM orders WHERE id=? AND user_id=? FOR UPDATE",
      [orderId, req.user.id]
    );
    if (!rows[0]) throw httpError(404, "Order not found.");
    if (rows[0].status !== "pending") throw httpError(400, "Only pending orders can be cancelled.");
    await cancelOrderTx(connection, orderId, req.user);
    await connection.commit();
    res.json({ message: "Order cancelled successfully." });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Admin updates order status
app.put("/api/orders/:id/status", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const orderId = Number(req.params.id);
  const status = String(req.body.status || "");
  if (!ORDER_STATUSES.includes(status)) throw httpError(400, "Invalid order status.");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT status FROM orders WHERE id=? FOR UPDATE", [orderId]);
    if (!rows[0]) throw httpError(404, "Order not found.");
    if (["completed", "cancelled"].includes(rows[0].status)) {
      throw httpError(400, "Order is finalized and cannot be modified.");
    }
    if (status === "cancelled") {
      await cancelOrderTx(connection, orderId, req.user);
    } else {
      await connection.execute("UPDATE orders SET status=? WHERE id=?", [status, orderId]);
    }
    await connection.commit();
    res.json({ message: "Order status updated successfully." });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Dashboard analytics
app.get("/api/stats", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT COUNT(*) AS total_products,
      COALESCE(SUM(quantity), 0) AS total_stock,
      COALESCE(SUM(quantity * cost_price), 0) AS stock_value
    FROM products
  `);
  const [orderRows] = await pool.execute(`
    SELECT
      COALESCE(SUM(CASE WHEN status='completed' THEN total ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) AS pending
    FROM orders
  `);
  const [lowStock] = await pool.execute(`
    SELECT id, product_code, name, price, quantity, low_stock_threshold, created_at
    FROM products
    WHERE quantity <= low_stock_threshold
    ORDER BY quantity ASC
  `);
  const [movementRows] = await pool.execute(`
    SELECT DATE(created_at) AS day,
      SUM(CASE WHEN type='in' THEN quantity ELSE 0 END) AS incoming,
      SUM(CASE WHEN type='out' THEN quantity ELSE 0 END) AS outgoing
    FROM inventory_movements
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `);
  const chart = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("sv-SE");
    const found = movementRows.find((r) => String(r.day).slice(0, 10) === key);
    chart.push({
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      incoming: Number(found?.incoming || 0),
      outgoing: Number(found?.outgoing || 0)
    });
  }
  res.json({
    products: Number(rows[0].total_products),
    stock: Number(rows[0].total_stock),
    stockValue: Number(rows[0].stock_value),
    revenue: Number(orderRows[0].revenue),
    pendingOrders: Number(orderRows[0].pending),
    chart,
    lowStock
  });
}));

// ---------- User Management (Admin only) ----------

app.get("/api/users", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT id, username, full_name, 'user' AS account_type, role, is_locked, created_at
    FROM users ORDER BY id DESC
  `);
  const [adminRows] = await pool.execute(`
    SELECT id, username, full_name, 'admin' AS account_type, role, is_locked, created_at
    FROM admins ORDER BY id DESC
  `);
  res.json([...adminRows, ...rows]);
}));

app.post("/api/users", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const fullName = String(req.body.full_name || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "viewer";

  if (!username || !fullName || password.length < 6) {
    throw httpError(400, "Missing required fields or password is too short.");
  }

  try {
    const passwordHash = hashPassword(password);
    if (role === "admin") {
      await pool.execute(
        `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'admin', FALSE)`,
        [username, fullName, passwordHash]
      );
    } else {
      await pool.execute(
        `INSERT INTO users (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'viewer', FALSE)`,
        [username, fullName, passwordHash]
      );
    }
    res.status(201).json({ message: "Account created successfully." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw httpError(409, "Username already exists.");
    throw error;
  }
}));

// Update user account (change role, lock/unlock)
app.put("/api/users/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw httpError(400, "Invalid account ID.");
  }

  let source = null;
  const requestedType = req.body.account_type === "admin" ? "admin" : req.body.account_type === "user" ? "user" : null;
  if (requestedType !== "user") {
    const [adminRows] = await pool.execute(
      "SELECT id, username, full_name, password_hash FROM admins WHERE id=?",
      [targetId]
    );
    if (adminRows[0]) source = { type: "admin", ...adminRows[0] };
  }
  if (!source && requestedType !== "admin") {
    const [userRows] = await pool.execute(
      "SELECT id, username, full_name, password_hash FROM users WHERE id=?",
      [targetId]
    );
    if (userRows[0]) source = { type: "user", ...userRows[0] };
  }
  if (!source) throw httpError(404, "Account not found.");

  const password = req.body.password ? String(req.body.password) : "";
  if (password && password.length < 6) {
    throw httpError(400, "Password must be at least 6 characters.");
  }
  const passwordHash = password ? hashPassword(password) : source.password_hash;

  if (req.body.role) {
    const desiredType = req.body.role === "admin" ? "admin" : "user";
    if (source.type !== desiredType) {
      if (desiredType === "admin") {
        await pool.execute(
          `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'admin', FALSE)`,
          [source.username, source.full_name, passwordHash]
        );
        await pool.execute("DELETE FROM users WHERE id=?", [targetId]);
      } else {
        await pool.execute(
          `INSERT INTO users (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'viewer', FALSE)`,
          [source.username, source.full_name, passwordHash]
        );
        await pool.execute("DELETE FROM admins WHERE id=?", [targetId]);
      }
      return res.json({ message: "Role updated successfully." });
    }
  }

  const updateData = { password_hash: passwordHash };
  if (typeof req.body.is_locked === "boolean") {
    updateData.is_locked = req.body.is_locked ? 1 : 0;
  }
  const fields = Object.keys(updateData).map((key) => `${key}=?`);
  const values = [...Object.values(updateData), targetId];
  await pool.execute(
    `UPDATE ${source.type === "admin" ? "admins" : "users"} SET ${fields.join(",")} WHERE id=?`,
    values
  );
  res.json({ message: "Account updated successfully." });
}));

// Delete account
app.delete("/api/users/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw httpError(400, "Invalid account ID.");
  }
  if (req.user.id === targetId) {
    throw httpError(400, "Cannot delete your own account.");
  }

  const [adminResult] = await pool.execute("DELETE FROM admins WHERE id=?", [targetId]);
  const [userResult] = await pool.execute("DELETE FROM users WHERE id=?", [targetId]);

  if (adminResult.affectedRows === 0 && userResult.affectedRows === 0) {
    throw httpError(404, "Account not found.");
  }
  res.json({ message: "Account deleted successfully." });
}));

// ---------- Database Initialization & Server Startup ----------

async function ensureColumn(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (!rows[0].total) {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Relax legacy non-null columns without defaults
async function relaxLegacyColumns(connection, table, knownColumns) {
  const [cols] = await connection.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
       AND EXTRA NOT LIKE '%auto_increment%' AND EXTRA NOT LIKE '%GENERATED%'`,
    [table]
  );
  for (const c of cols) {
    if (knownColumns.includes(c.COLUMN_NAME)) continue;
    await connection.execute(`ALTER TABLE ${table} MODIFY \`${c.COLUMN_NAME}\` ${c.COLUMN_TYPE} NULL`);
    console.log(`Updated column to allow NULL: ${table}.${c.COLUMN_NAME}`);
  }
}

async function startServer() {
  try {
    console.log("Connecting to Railway MySQL...");
    const connection = await pool.getConnection();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_code VARCHAR(100) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        quantity INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const productColumns = [
      ["sku", "VARCHAR(100) NULL"],
      ["image", "LONGTEXT NULL"],
      ["category_id", "INT NULL"],
      ["brand_id", "INT NULL"],
      ["cost_price", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
      ["status", "VARCHAR(20) NOT NULL DEFAULT 'active'"],
      ["low_stock_threshold", "INT NOT NULL DEFAULT 5"],
      ["import_date", "DATE NULL"]
    ];
    for (const [column, definition] of productColumns) {
      await ensureColumn(connection, "products", column, definition);
    }
    await connection.execute("UPDATE products SET sku=product_code WHERE sku IS NULL OR sku=''");

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS brands (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        type VARCHAR(10) NOT NULL,
        quantity INT NOT NULL,
        note VARCHAR(255),
        user_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_product_movement (product_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    // Actor name for movements
    await ensureColumn(connection, "inventory_movements", "actor_name", "VARCHAR(100) NULL");

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        full_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        full_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'admin',
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await ensureColumn(connection, "admins", "is_locked", "BOOLEAN NOT NULL DEFAULT FALSE");
    await ensureColumn(connection, "users", "is_locked", "BOOLEAN NOT NULL DEFAULT FALSE");
    // Personal contact columns
    for (const table of ["users", "admins"]) {
      await ensureColumn(connection, table, "phone", "VARCHAR(20) NULL");
      await ensureColumn(connection, table, "address", "VARCHAR(255) NULL");
    }

    await connection.execute("UPDATE users SET role='viewer' WHERE role IN ('staff','warehouse')");
    await connection.execute("UPDATE users SET is_locked=FALSE WHERE role='admin'");

    // Migrate legacy admin accounts if needed
    const [legacyAdmins] = await connection.execute(
      "SELECT username, full_name, password_hash, is_locked FROM users WHERE role='admin'"
    );
    for (const legacyAdmin of legacyAdmins) {
      await connection.execute(
        `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'admin', ?)
         ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), password_hash=VALUES(password_hash), is_locked=VALUES(is_locked)`,
        [legacyAdmin.username, legacyAdmin.full_name, legacyAdmin.password_hash, Boolean(legacyAdmin.is_locked)]
      );
      await connection.execute("DELETE FROM users WHERE username=?", [legacyAdmin.username]);
    }

    // Orders schema
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        customer_username VARCHAR(50) NOT NULL,
        receiver_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        address VARCHAR(255) NOT NULL,
        note VARCHAR(255) NULL,
        total DECIMAL(15,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_orders_user (user_id),
        INDEX idx_orders_status (status)
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NULL,
        product_name VARCHAR(255) NOT NULL,
        product_code VARCHAR(100) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `);

    // Ensure missing columns for orders/order_items
    const orderColumns = [
      ["user_id", "INT NOT NULL DEFAULT 0"],
      ["customer_username", "VARCHAR(50) NOT NULL DEFAULT ''"],
      ["receiver_name", "VARCHAR(100) NOT NULL DEFAULT ''"],
      ["phone", "VARCHAR(20) NOT NULL DEFAULT ''"],
      ["address", "VARCHAR(255) NOT NULL DEFAULT ''"],
      ["note", "VARCHAR(255) NULL"],
      ["total", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
      ["status", "VARCHAR(20) NOT NULL DEFAULT 'pending'"]
    ];
    for (const [column, definition] of orderColumns) {
      await ensureColumn(connection, "orders", column, definition);
    }
    const itemColumns = [
      ["product_id", "INT NULL"],
      ["product_name", "VARCHAR(255) NOT NULL DEFAULT ''"],
      ["product_code", "VARCHAR(100) NOT NULL DEFAULT ''"],
      ["price", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
      ["quantity", "INT NOT NULL DEFAULT 1"]
    ];
    for (const [column, definition] of itemColumns) {
      await ensureColumn(connection, "order_items", column, definition);
    }
    await relaxLegacyColumns(connection, "orders", ["id"]);
    await relaxLegacyColumns(connection, "order_items", ["id", "order_id"]);

    const adminUsername = String(process.env.ADMIN_USERNAME || "admin").trim();
    const adminPassword = String(process.env.ADMIN_PASSWORD || "Admin123456");
    if (adminUsername && adminPassword.length >= 6) {
      const [adminRows] = await connection.execute("SELECT id FROM admins WHERE username=?", [adminUsername]);
      if (adminRows.length === 0) {
        await connection.execute(
          `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'admin', FALSE)`,
          [adminUsername, "System Administrator", hashPassword(adminPassword)]
        );
        console.log(`Default admin account created: ${adminUsername}`);
      } else {
        console.log(`Admin account ready: ${adminUsername}`);
      }
    }

    connection.release();
    await pool.query("SELECT 1");

    console.log("MySQL connected successfully.");
    console.log("All tables are ready.");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Application startup failed:");
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
    process.exit(1);
  }
}

startServer();
