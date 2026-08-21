# Spotify Streams - Fan Dashboard

Bu proje, belirlenen sanatçıların (Justin Timberlake, LISA, Lady Gaga, Billie Eilish, Ariana Grande, *NSYNC ve JC Chasez) Spotify stream sayılarını periyodik olarak tarayıp PostgreSQL veritabanına kaydeder ve bu verileri şık bir web arayüzünde sunar.

## Kurulum ve Localhost'ta Çalıştırma

### 1. Gereksinimler
*   **Node.js**: Sisteminizde Node.js (v18+) kurulu olmalıdır.
*   **PostgreSQL**: Verilerin saklanması için PostgreSQL veritabanı (projede şu an Supabase kullanılmaktadır — session pooler, port 5432, `?sslmode=no-verify`).
*   **Spotify SP_DC Çerezi**: Spotify'ın internal API'lerinden playcount verisini çekebilmek için tarayıcınızdan alacağınız geçerli bir `sp_dc` cookie değeri gereklidir.

---

### 2. Çevre Değişkenleri (.env)
Proje kök dizininde (root) bir `.env` dosyası bulunmalıdır. Yoksa `.env.example` dosyasını kopyalayarak oluşturabilirsiniz:

```bash
cp .env.example .env
```

`.env` dosyasının içeriği şu şekildedir:
*   `SP_DC`: Spotify web player'dan alınan geçerli `sp_dc` cookie değeri.
*   `DATABASE_URL`: PostgreSQL bağlantı dizesi (`postgresql://...`).
*   `SPOTIFY_CLIENT_ID` ve `SPOTIFY_CLIENT_SECRET`: Spotify Developer Dashboard'dan alınan API anahtarları (Albüm keşfi için gereklidir).

---

### 3. Veritabanı Migrasyonları (İlk Kurulum)
Veritabanı tablolarını ve gerekli görünümleri (views) oluşturmak için scraper servisindeki migrasyon komutunu çalıştırın:

```bash
cd services/spotify-scraper
npm install
npm run migrate
```

---

### 4. Scraper (Tarayıcı) Çalıştırma
Verileri Spotify'dan çekmek ve güncellemek için scraper'ı çalıştırabilirsiniz:

```bash
cd services/spotify-scraper
# Sadece veri güncellendiğinde taramak için:
npm run scrape

# Tarama işlemini zorla başlatmak için (canary check bypass):
node scraper.js --force
```

---

### 5. Web Dashboard Arayüzünü Localhost'ta Çalıştırma
Kullanıcı arayüzünü (web dashboard) başlatmak için:

```bash
cd services/web-dashboard
npm install

# Geliştirici modunda (nodemon ile otomatik yeniden başlatma):
npm run dev

# Normal modda başlatmak için:
npm start
```

Sunucu varsayılan olarak **`http://localhost:3000`** adresinde çalışacaktır. Tarayıcınızda bu adresi açarak dashboard'a erişebilirsiniz. Giriş yapmak için veritabanında yer alan geçerli bir erişim kodunu (passcode) kullanmanız gerekmektedir.
