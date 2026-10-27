const $ = (s) => document.querySelector(s);
const money = (n) => Number(n || 0).toLocaleString("vi-VN") + " đ";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let me = null, cart = [], productsCache = [], editingId = null, pimage = null, timer;

function toast(msg, err) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  clearTimeout(timer); timer = setTimeout(() => (t.className = "toast"), 2800);
}

async function api(path, method = "GET", body) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.token || "") },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") { logout(); throw new Error(data.message); }
  if (!res.ok) throw new Error(data.message || "Có lỗi xảy ra.");
  return data;
}
const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- Đăng nhập ----------
$("#loginForm").addEventListener("submit", run(async (e) => {
  e.preventDefault();
  const r = await api("/login", "POST", { username: $("#lu").value, password: $("#lp").value });
  localStorage.token = r.token; $("#lp").value = "";
  start(r.user);
}));
// ---------- Đăng ký ----------
function showAuth(reg) { $("#loginForm").hidden = reg; $("#regForm").hidden = !reg; }
$("#toReg").onclick = (e) => { e.preventDefault(); showAuth(true); };
$("#toLogin").onclick = (e) => { e.preventDefault(); showAuth(false); };
$("#regForm").addEventListener("submit", run(async (e) => {
  e.preventDefault();
  if ($("#rp").value !== $("#rp2").value) throw new Error("Mật khẩu nhập lại không khớp.");
  await api("/register", "POST", { full_name: $("#rf").value, username: $("#ru").value, password: $("#rp").value });
  $("#lu").value = $("#ru").value; $("#regForm").reset(); showAuth(false);
  toast("Đăng ký thành công. Hãy đăng nhập.");
}));
function logout() { localStorage.removeItem("token"); me = null; cart = []; $("#app").hidden = true; $("#login").hidden = false; }
$("#logout").onclick = logout;

function start(user) {
  me = user;
  $("#login").hidden = true; $("#app").hidden = false;
  $("#whoami").textContent = `${user.full_name} (${user.role === "admin" ? "Quản trị" : "Nhân viên"})`;
  $("#usersPanel").hidden = user.role !== "admin";
  showTab("dash");
  loadProducts(); renderCart();
}
(async () => { if (localStorage.token) { try { start(await api("/me")); } catch { logout(); } } })();

// ---------- Tabs ----------
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== name));
  if (name === "dash") { loadStats(); if (me.role === "admin") loadUsers(); }
  else { loadProducts(); loadOrders(); }
}

// ---------- Dashboard ----------
const loadStats = run(async () => {
  const s = await api("/stats");
  $("#stats").innerHTML = `
    <div class="stat main"><span>Tổng doanh thu</span><b>${money(s.revenue)}</b><small>Hôm nay: ${money(s.todayRevenue)}</small></div>
    <div class="stat"><span>Đơn hàng</span><b>${s.orders}</b></div>
    <div class="stat"><span>Loại sản phẩm</span><b>${s.products}</b></div>
    <div class="stat"><span>Tổng tồn kho</span><b>${s.stock}</b></div>`;
  const max = Math.max(...s.last7days.map((d) => d.total), 1);
  $("#bars").innerHTML = s.last7days.map((d) =>
    `<div class="bar"><em>${d.total ? Math.round(d.total / 1000) + "k" : ""}</em><i style="height:${(d.total / max) * 85}%"></i>${d.label}</div>`).join("");
  $("#top").innerHTML = s.topProducts.length
    ? s.topProducts.map((p) => `<li>${esc(p.name)}<span class="r">${p.sold} đã bán</span></li>`).join("")
    : '<div class="empty">Chưa có đơn hàng nào.</div>';
  $("#low").innerHTML = s.lowStock.length
    ? s.lowStock.map((p) => `<li>${esc(p.name)} <span class="code">${esc(p.product_code)}</span><span class="r low">còn ${p.quantity}</span></li>`).join("")
    : '<div class="empty">Tất cả sản phẩm đều đủ hàng.</div>';
});

// ---------- Quản lý tài khoản ----------
const loadUsers = run(async () => {
  const rows = await api("/users");
  $("#users").innerHTML = rows.map((u) => `<tr>
    <td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td>
    <td>${u.id === me.id ? (u.role === "admin" ? "Quản trị viên" : "Nhân viên") :
      `<select data-role="${u.id}"><option value="staff" ${u.role === "staff" ? "selected" : ""}>Nhân viên</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>Quản trị viên</option></select>`}</td>
    <td>${esc(u.created_at)}</td>
    <td class="act"><button class="btn ghost sm" data-pw="${u.id}">Đặt lại mật khẩu</button>${u.id === me.id ? "" : `<button class="btn ghost sm danger" data-deluser="${u.id}">Xóa</button>`}</td></tr>`).join("");
});
$("#users").addEventListener("change", run(async (e) => {
  if (!e.target.dataset.role) return;
  await api("/users/" + e.target.dataset.role, "PUT", { role: e.target.value }); toast("Đã đổi quyền.");
}));
$("#users").addEventListener("click", run(async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.pw) {
    const p = prompt("Nhập mật khẩu mới (từ 6 ký tự):"); if (!p) return;
    await api("/users/" + b.dataset.pw, "PUT", { password: p }); toast("Đã đặt lại mật khẩu.");
  }
  if (b.dataset.deluser && confirm("Xóa tài khoản này?")) { await api("/users/" + b.dataset.deluser, "DELETE"); toast("Đã xóa tài khoản."); loadUsers(); }
}));
$("#addUser").onclick = () => { $("#uform").reset(); $("#udlg").showModal(); };
$("#uform").addEventListener("submit", run(async (e) => {
  if (e.submitter?.hasAttribute("data-close")) return;
  await api("/users", "POST", { username: $("#uname").value, full_name: $("#ufull").value, password: $("#upass").value, role: $("#urole").value });
  $("#udlg").close(); toast("Đã tạo tài khoản."); loadUsers();
}));
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

// ---------- Sản phẩm ----------
const loadProducts = run(async () => {
  productsCache = await api("/products?search=" + encodeURIComponent($("#search").value.trim()));
  renderProducts();
});
function renderProducts() {
  $("#products").innerHTML = productsCache.length ? productsCache.map((p) => `<tr>
    <td>${p.id}</td>
    <td>${p.image ? `<img class="thumb" src="${p.image}" alt="">` : '<span class="thumb"></span>'}</td>
    <td>${esc(p.name)}<div class="code">${esc(p.product_code)}</div></td>
    <td class="r">${money(p.price)}</td>
    <td class="r ${p.quantity <= 5 ? "low" : ""}">${p.quantity}</td>
    <td>${esc(p.import_date)}</td>
    <td class="act">
      <button class="btn sm" data-add="${p.id}" ${p.quantity ? "" : "disabled"}>Thêm vào giỏ</button>
      <button class="btn ghost sm" data-edit="${p.id}">Sửa</button>
      ${me.role === "admin" ? `<button class="btn ghost sm danger" data-del="${p.id}">Xóa</button>` : ""}
    </td></tr>`).join("") : '<tr><td colspan="7" class="empty">Không tìm thấy sản phẩm. Bấm "Thêm sản phẩm" để tạo mới.</td></tr>';
}
let st; $("#search").addEventListener("input", () => { clearTimeout(st); st = setTimeout(loadProducts, 250); });

$("#products").addEventListener("click", run(async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.add) addToCart(Number(b.dataset.add));
  if (b.dataset.edit) openProduct(productsCache.find((p) => p.id == b.dataset.edit));
  if (b.dataset.del && confirm("Xóa sản phẩm này?")) {
    await api("/products/" + b.dataset.del, "DELETE"); toast("Đã xóa sản phẩm.");
    cart = cart.filter((c) => c.id != b.dataset.del); renderCart(); loadProducts();
  }
}));

function openProduct(p) {
  editingId = p ? p.id : null; pimage = p?.image || null;
  $("#ptitle").textContent = p ? "Sửa sản phẩm" : "Thêm sản phẩm";
  $("#pcode").value = p?.product_code || ""; $("#pname").value = p?.name || "";
  $("#pprice").value = p?.price || ""; $("#pqty").value = p?.quantity ?? "";
  $("#pdate").value = p?.import_date || new Date().toLocaleDateString("sv-SE");
  $("#pimgPrev").src = pimage || "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  $("#pdlg").showModal();
}
$("#addProduct").onclick = () => openProduct(null);

// Thu nhỏ ảnh trước khi gửi lên server (giới hạn ~1.5MB)
$("#pimg").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 480 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = img.width * k; c.height = img.height * k;
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    pimage = c.toDataURL("image/jpeg", 0.8); $("#pimgPrev").src = pimage;
  };
  img.src = URL.createObjectURL(f);
});

$("#pform").addEventListener("submit", run(async (e) => {
  if (e.submitter?.hasAttribute("data-close")) return;
  const body = { product_code: $("#pcode").value, name: $("#pname").value, price: $("#pprice").value,
    quantity: $("#pqty").value, import_date: $("#pdate").value, image: pimage };
  const r = editingId ? await api("/products/" + editingId, "PUT", body) : await api("/products", "POST", body);
  $("#pdlg").close(); toast(r.message);
  cart = cart.filter((c) => c.id !== editingId); renderCart(); loadProducts();
}));

// ---------- Giỏ hàng & đơn hàng ----------
function addToCart(id) {
  const p = productsCache.find((x) => x.id === id); if (!p) return;
  const c = cart.find((x) => x.id === id);
  if (c) { if (c.qty >= p.quantity) return toast(`Chỉ còn ${p.quantity} sản phẩm trong kho.`, true); c.qty++; }
  else cart.push({ id, name: p.name, price: p.price, qty: 1, max: p.quantity });
  renderCart();
}
function renderCart() {
  $("#cartItems").innerHTML = cart.length ? cart.map((c) => `<div class="item">
    <div>${esc(c.name)}<div class="qty"><button data-dec="${c.id}" aria-label="Giảm">−</button>${c.qty}<button data-inc="${c.id}" aria-label="Tăng">+</button></div></div>
    <div class="r">${money(c.price * c.qty)}<br><button class="btn ghost sm danger" data-rm="${c.id}">Bỏ</button></div></div>`).join("")
    : '<div class="empty">Chưa có sản phẩm. Bấm "Thêm vào giỏ" ở danh sách.</div>';
  $("#cartTotal").textContent = money(cart.reduce((s, c) => s + c.price * c.qty, 0));
  $("#buy").disabled = !cart.length;
}
$("#cartItems").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const id = Number(b.dataset.inc || b.dataset.dec || b.dataset.rm), c = cart.find((x) => x.id === id);
  if (b.dataset.inc) { if (c.qty >= c.max) return toast(`Chỉ còn ${c.max} sản phẩm trong kho.`, true); c.qty++; }
  if (b.dataset.dec && --c.qty <= 0) cart = cart.filter((x) => x.id !== id);
  if (b.dataset.rm) cart = cart.filter((x) => x.id !== id);
  renderCart();
});
$("#buy").onclick = run(async () => {
  const r = await api("/orders", "POST", { customer_name: $("#customer").value, items: cart.map((c) => ({ product_id: c.id, quantity: c.qty })) });
  toast(`Mua hàng thành công. Đơn #${r.id}: ${money(r.total)}`);
  cart = []; $("#customer").value = ""; renderCart(); loadProducts(); loadOrders();
});

const loadOrders = run(async () => {
  const rows = await api("/orders");
  $("#orders").innerHTML = rows.length ? rows.map((o) => `<tr>
    <td>#${o.id}</td><td>${esc(o.created_at)}</td><td>${esc(o.customer_name)}</td>
    <td>${o.items.map((i) => `${esc(i.product_name)} × ${i.quantity}`).join("<br>")}</td>
    <td>${esc(o.seller_name)}</td><td class="r"><b>${money(o.total)}</b></td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">Chưa có đơn hàng nào.</td></tr>';
});
renderCart();