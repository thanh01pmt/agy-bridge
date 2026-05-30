# Antigravity CLI (agy) Integration Bridge

Dự án này triển khai 3 cách kết nối (bridge) Antigravity CLI (`agy`) trên máy chủ Oracle VM để sử dụng cho các ứng dụng khác như **Pi Agent**, **n8n**, hoặc các mã nguồn tự động của bạn.

## Cấu Trúc Dự Án
```text
agy-bridge/
├── package.json
├── server.js               # Cách 2: Web API Server (Express)
├── mcp_server.js           # Cách 3: Model Context Protocol Server (Stdio)
├── deploy.sh               # Kịch bản đồng bộ code từ Mac lên Remote VM
└── wrappers/               # Cách 1: Thư viện wrapper chạy trực tiếp tiến trình con
    ├── node_wrapper.js     # Wrapper cho Node.js
    └── python_wrapper.py   # Wrapper cho Python
```

---

## 🛠️ HƯỚNG DẪN THIẾT LẬP BAN ĐẦU (AUTHENTICATION)

Vì Antigravity CLI (`agy`) yêu cầu đăng nhập tài khoản Google lần đầu chạy, bạn cần làm bước này trực tiếp trên SSH:

1. **SSH vào remote server**:
   ```bash
   cd /Users/tonypham/MEGA/WebApp/the-second-brain/Secrets/oracle-advanced-compute
   ssh -i ssh-key-2026-05-29.key ubuntu@140.245.127.64
   ```
2. **Kích hoạt PATH và chạy lệnh login**:
   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   agy --print "hello"
   ```
3. **Thực hiện Login**:
   * CLI sẽ in ra một liên kết OAuth của Google (ví dụ `https://accounts.google.com/o/oauth2/...`).
   * Copy link đó dán vào trình duyệt của bạn để thực hiện đăng nhập và xác thực quyền.
   * Sau khi hoàn tất đăng nhập, Google sẽ hiển thị một **mã xác thực (authorization code)**.
   * Quay lại cửa sổ SSH, dán mã xác thực đó và nhấn **Enter**.
   * Khi thấy dòng kết quả in ra của câu lệnh "hello", việc xác thực đã hoàn thành và lưu cấu hình vĩnh viễn trên server.

---

## 🚀 CHI TIẾT 3 CÁCH TRIỂN KHAI BRIDGE

### Cách 1: Gọi Trực Tiếp Qua Subprocess (Trong Code NodeJS / Python)

* **Với Node.js (`wrappers/node_wrapper.js`)**:
  ```javascript
  import { runAgy } from './wrappers/node_wrapper.js';
  
  const res = await runAgy("Hãy viết một hàm QuickSort bằng Python");
  if (res.success) {
    console.log(res.stdout);
  } else {
    console.error("Lỗi:", res.stderr);
  }
  ```

* **Với Python (`wrappers/python_wrapper.py`)**:
  ```python
  from wrappers.python_wrapper import run_agy
  
  res = run_agy("Hãy viết một hàm QuickSort bằng Python")
  if res["success"]:
      print(res["stdout"])
  else:
      print("Lỗi:", res["stderr"])
  ```

---

### Cách 2: Gọi Qua Local Web API Server (Express)

Web API giúp các ứng dụng khác (ví dụ như **n8n**) gọi qua HTTP Request.

1. **Chạy Server**:
   ```bash
   # Chạy trên server:
   cd ~/agy-bridge
   npm run start:api
   ```
   *Mặc định server sẽ chạy trên cổng `3999`.*

2. **Cách gọi qua HTTP POST**:
   * **Endpoint**: `http://localhost:3999/api/agent`
   * **Headers**: `X-Bridge-Secret: antigravity-bridge-secret-123`
   * **Body (JSON)**:
     ```json
     {
       "prompt": "Hãy giải thích sự khác biệt giữa Docker và VM"
     }
     ```
   * **Response (JSON)**:
     ```json
     {
       "success": true,
       "output": "[Kết quả trả về từ Antigravity Agent...]",
       "error": null
     }
     ```

---

### Cách 3: Kết Nối Qua Model Context Protocol (MCP) Server

Phù hợp nhất để tích hợp trực tiếp vào **Pi Agent**, **Claude Desktop** hoặc bất kỳ công cụ nào hỗ trợ MCP Client.

1. **Cách hoạt động**: Server giao tiếp qua luồng nhập/xuất chuẩn (`stdio`).
2. **Kích hoạt công cụ (`run_antigravity_task`)**:
   Khi bạn cấu hình MCP Server cho Pi Agent hoặc Claude Desktop, hãy chỉ định lệnh khởi chạy như sau:
   ```json
   {
     "mcpServers": {
       "antigravity-bridge": {
         "command": "node",
         "args": ["/home/ubuntu/agy-bridge/mcp_server.js"]
       }
     }
   }
   ```
3. Sau khi tích hợp, các LLM sẽ có quyền gọi Tool `run_antigravity_task` trực tiếp để chuyển giao nhiệm vụ lập trình dài hạn cho Antigravity CLI tự xử lý.
