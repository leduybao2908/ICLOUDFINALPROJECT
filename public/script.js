// Dữ liệu mẫu (sau này sẽ lấy từ MySQL qua API)
let products = [
  { id: 1, name: 'Áo thun', price: 150000, description: 'Áo thun cotton' },
  { id: 2, name: 'Quần jean', price: 350000, description: 'Quần jean nam' },
  { id: 3, name: 'Giày thể thao', price: 800000, description: 'Giày chạy bộ' }
];

const productList = document.getElementById('productList');
const addForm = document.getElementById('addForm');
const searchInput = document.getElementById('searchInput');

// Hiển thị danh sách ra bảng
function renderProducts(list) {
  productList.innerHTML = '';

  if (list.length === 0) {
    productList.innerHTML = '<tr><td colspan="4">Không có sản phẩm nào</td></tr>';
    return;
  }

  list.forEach(p => {
    const row = `
      <tr>
        <td>${p.id}</td>
        <td>${p.name}</td>
        <td>${Number(p.price).toLocaleString('vi-VN')} đ</td>
        <td>${p.description || ''}</td>
      </tr>`;
    productList.innerHTML += row;
  });
}

// Thêm sản phẩm
addForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const newProduct = {
    id: products.length + 1,
    name: document.getElementById('name').value,
    price: document.getElementById('price').value,
    description: document.getElementById('description').value
  };

  products.push(newProduct); // TODO: sau này đổi thành gọi API thêm vào MySQL
  renderProducts(products);
  addForm.reset();
});

// Tìm kiếm sản phẩm
searchInput.addEventListener('input', () => {
  const keyword = searchInput.value.toLowerCase();
  const result = products.filter(p => p.name.toLowerCase().includes(keyword));
  renderProducts(result); // TODO: sau này đổi thành gọi API tìm kiếm
});

// Chạy lần đầu khi mở trang
renderProducts(products);