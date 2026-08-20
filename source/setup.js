#!/usr/bin/env node
// setup.js - Giải nén bundle.tar.gz vào đúng vị trí. Chạy: node setup.js
// Chỉ dùng built-in Node (zlib), ko cần npm install gì để chạy được file này.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUNDLE = path.join(__dirname, 'bundle.tar.gz');
if (!fs.existsSync(BUNDLE)) {
    console.error('❌ Không tìm thấy bundle.tar.gz (phải để cùng thư mục với setup.js)');
    process.exit(1);
}

// Giải nén gzip -> lấy dữ liệu tar thô
const tarBuffer = zlib.gunzipSync(fs.readFileSync(BUNDLE));

// Parse tar thủ công: mỗi entry gồm header 512 byte + nội dung (pad tới bội
// số 512). Chỉ cần đọc đúng 3 field: tên file (offset 0, 100 byte), kích
// thước (offset 124, 12 byte, dạng octal ASCII), và loại entry (offset 156,
// 1 byte: '5' = thư mục, '0'/'\0' = file thường).
let offset = 0;
let count = 0;
while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break; // 2 block rỗng liên tiếp = hết tar

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    offset += 512;

    if (name) {
        const destPath = path.join(__dirname, name);
        if (typeFlag === '5' || name.endsWith('/')) {
            fs.mkdirSync(destPath, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, tarBuffer.subarray(offset, offset + size));
            count++;
            console.log('✔', name);
        }
    }

    offset += Math.ceil(size / 512) * 512; // nhảy qua nội dung (đã pad bội số 512)
}

console.log(`\n✅ Xong. Đã giải nén ${count} file vào đúng vị trí (cạnh setup.js).`);
console.log('Tiếp theo: npm install acorn acorn-walk, rồi npm install && node index.js (hoặc theo cấu hình Pterodactyl của bạn).');
