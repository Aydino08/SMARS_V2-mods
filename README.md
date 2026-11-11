# Tank Robot — Railway serveri

Bu server brauzer ilə ESP32-S3 robotu arasında körpü rolunu oynayır:

```
Telefon / kompüter  <--WSS-->  Railway (bu server)  <--WSS-->  ESP32 robot
```

Robot özü serverə qoşulur (çölə doğru bağlantı), ona görə router-də port açmaq, DDNS və s. lazım deyil.

## Fayllar

| Fayl | Nə üçündür |
|---|---|
| `server.js` | HTTP + WebSocket relay |
| `public/index.html` | Brauzer idarəetmə paneli (robotun yerli paneli ilə eyni görünüş) |
| `package.json` | Node asılılıqları (`ws`) və `npm start` |

## Mühit dəyişənləri (Railway → Variables)

| Ad | Məcburi | Nə üçündür |
|---|---|---|
| `ROBOT_KEY` | bəli, min. **12** simvol | Robotun gizli açarı. ESP32-dəki açarla **eyni** olmalıdır |
| `UI_PASSWORD` | bəli, min. **6** simvol | Veb panelə giriş şifrəsi |
| `PORT` | yox | Railway özü təyin edir, toxunma |

Açar yaratmaq üçün (kompüterdə): `openssl rand -hex 16`

## Deploy — Yol A: GitHub + Railway paneli (ən asan)

1. Bu qovluğun məzmununu (`server.js`, `package.json`, `package-lock.json`, `public/`, `.gitignore`) yeni GitHub repozitoriyasına yüklə. `node_modules` yüklənmir (`.gitignore` buna baxır).
2. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → repozitoriyanı seç.
3. Servisi aç → **Variables** → `ROBOT_KEY` və `UI_PASSWORD` əlavə et. Railway avtomatik yenidən deploy edəcək.
4. **Settings → Networking → Generate Domain** düyməsi. Nəticə belə olacaq: `tank-xxxx.up.railway.app`.
5. Brauzerdə `https://tank-xxxx.up.railway.app` aç. Giriş pəncərəsi çıxmalıdır.
6. Yoxlama: `https://tank-xxxx.up.railway.app/healthz` → `{"ok":true,"configured":true}` qaytarmalıdır (`configured:false` olarsa dəyişənlər çatışmır).

## Deploy — Yol B: Railway CLI

```bash
npm i -g @railway/cli
railway login
cd tank-railway-server
railway init            # yeni layihə yarat
railway up              # kodu yüklə və deploy et
railway domain          # ictimai ünvan yarat
```

Dəyişənləri paneldən (Variables) əlavə et, ya da CLI-da: `railway variable set ROBOT_KEY=... UI_PASSWORD=...` (CLI versiyasından asılı olaraq sintaksis fərqli ola bilər, `railway variable --help`-ə bax).
Əgər `railway up` servis tapmadığını desə, paneldə layihəni açıb **Empty Service** əlavə et, sonra `railway service` ilə seç və `railway up`-ı təkrarla.

## Robotu qoşmaq

**Variant 1 — kodda (`tank_robot.ino`, 58–61-ci sətirlər):**

```cpp
const char* const DEFAULT_STA_SSID   = "TelefonHotspot";
const char* const DEFAULT_STA_PASS   = "wifi_sifresi";
const char* const DEFAULT_CLOUD_HOST = "tank-xxxx.up.railway.app";   // https:// YAZMA
const char* const DEFAULT_CLOUD_KEY  = "Railway-dəki ROBOT_KEY";
```

**Variant 2 — robotun öz panelindən:** robotun Wi-Fi-na qoşul (`TankRobot`, `192.168.4.1`) → aşağıdakı **Cloud (Railway)** kartında Wi-Fi adı, şifrə, server ünvanı və açarı yaz → **Yadda saxla** → **Yenidən başlat**. Bu dəyərlər yaddaşda qalır.

Wi-Fi, server ünvanı və açar yalnız yerli paneldən dəyişdirilə bilər. Cloud üzərindən bu marşrutlar (`/wifi`, `/net`, `/reboot`, `/factory`) bağlıdır.

## Kitabxanalar (Arduino IDE)

- **ESP32Servo**
- **WebSockets** (müəllif: Markus Sattler)
- ESP32 board paketi **3.0.4 və ya yuxarı** (3.3.x məsləhətdir). `Preferences` daxilidir.

## Yoxlama

Robot qoşulandan sonra brauzer panelinin yuxarısında **● ROBOT ONLINE · NN ms** yazısı çıxır. Robotun yerli panelindəki Cloud kartında status: `✓ Servərə qoşulub · … · TLS ✓ (sertifikat yoxlanır)`.

## Təhlükəsizlik

- Robot və panel ayrı gizli məlumatla qorunur (açar / şifrə). Səhv cəhdlər IP üzrə məhdudlaşdırılır (10 dəqiqədə 5 səhv → bloklanma).
- Marşrut siyahısı məhduddur: yalnız `/tank /mode /servo /status /settings /set /reset` cloud-dan icazəlidir.
- **Ölü adam dayanması:** əl rejimində robot 0.7 san ərzində yeni sürücülük əmri almasa, dayanır. Əlaqə qopsa da dayanır. Avtonom rejimlər (maneə, xətt, arena) əlaqə qopsa davam edir.
- Şifrəni dəyişmək üçün Railway-də `UI_PASSWORD`-u dəyiş, servis yenidən başlayacaq.

## Problemlər

| Əlamət | Səbəb / həll |
|---|---|
| Səhifədə `503` və izah | `ROBOT_KEY` / `UI_PASSWORD` yoxdur və ya qısadır → Variables bölməsinə bax |
| Panel açılır, amma **ROBOT OFFLINE** | Robot qoşulmayıb: Wi-Fi **2.4 GHz** olmalıdır (5 GHz işləmir); server ünvanında `https://` olmasın; açar `ROBOT_KEY` ilə eyni olsun |
| Cloud kartında `TLS şifrəli, sertifikat YOXLANMIR` | Əlaqə şifrəlidir, amma server kimliyi yoxlanmır (core-un sertifikat paketi tapılmayıb). ESP32 core-u 3.0.4+ versiyasına yenilə |
| Robot heç vaxt qoşulmur, Cloud kartında status "Servərə qoşulur" | "TLS sertifikatını yoxla" düyməsini söndürüb yenidən başlat; saat sinxronizasiyası (NTP) üçün internet olmalıdır |
| Bir neçə səhv şifrədən sonra giriş qəbul olunmur | IP müvəqqəti bloklanıb, 10 dəqiqə gözlə |
| Robot hərəkət etmir, amma ONLINE | Əl rejimində olduğundan əmin ol; düyməni basılı saxla (əmr 150 ms-dən bir təkrarlanır) |
| Latency yüksəkdir | Robotun Wi-Fi siqnalı zəifdir (`rssi` Cloud kartında görünür) və ya Railway regionu uzaqdır (Settings → Region) |
| Deploy uğursuz | Railway → Deployments → Logs. `node >= 18` tələb olunur, Railpack bunu avtomatik seçir |

## Lokal sınaq (istəyə bağlı)

```bash
cd tank-railway-server
npm install
ROBOT_KEY=test-robot-key-123 UI_PASSWORD=parol123 npm start
# brauzer: http://localhost:3000
```

## Qiymət

Railway-in hazırkı plan və pulsuz kredit şərtləri vaxtaşırı dəyişir; [railway.com/pricing](https://railway.com/pricing) səhifəsinə bax. Bu server çox az resurs işlədir.
