# Gunakan image node resmi versi alpine yang ringan
FROM node:18-alpine

# Tentukan direktori kerja di dalam container
WORKDIR /usr/src/app

# Salin file package.json dan package-lock.json (jika ada)
COPY package*.json ./

# Install dependensi aplikasi
RUN npm install

# Salin semua file project ke dalam container
COPY . .

# Beritahu Docker port mana yang akan digunakan
EXPOSE 3000

# Perintah untuk menjalankan aplikasi saat container dimulai
CMD ["npm", "start"]
