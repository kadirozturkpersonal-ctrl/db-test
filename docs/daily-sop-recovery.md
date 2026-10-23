# Günlük SOP görevi ve kesinti kurtarma

Windows görevi `ECHR Daily SOP Check - 0007`, Türkiye saatiyle 00:07'de
başlar. 01:57'ye kadar on dakikada bir yeniden tetiklenir; `IgnoreNew` ve
tek-süreç kilidi aynı anda ikinci tarayıcıyı önler. Görev hatalarında ayrıca
beş dakika arayla üç yeniden başlatma bulunur. Sadece bu görevi kurmak için:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-echr-daily-sop-task.ps1
```

## İşleyiş

1. Kimlik doğrulamalı panel GET endpointinden o günün SOP havuzu alınır.
   AYM, numarasız dosyalar, nihai SOP ve doğrulanmış HUDOC kararları taranmaz.
   Çarşamba HUDOC aşaması varsa önce panelde tamamlanır; diğer günler HUDOC
   sorgusu yapılmaz. Eski D1 abonelik listesine sessiz geri dönüş yoktur.
2. Her SOP sonucu küçük D1 REST sorgusuyla yazılır. Tek kayıt için bulk/R2
   import veya Wrangler/PowerShell çıktı hattı kullanılmaz.
3. Başarılı her kayıttan sonra aynı Türkiye gününe ait atomik checkpoint
   yazılır. Çökme/yeniden başlatmada yalnız tamamlanmamış kayıtlar taranır.
4. Beş dakika ilerlemeyen sahipli alt süreç sonlandırılır ve tekrar denenir.
   Hata kodu, sinyal ve stdout/stderr ayrı UTF-8 günlüklerine kaydedilir.
   Destekleyen Node sürümlerinde ortam değişkenleri hariç fatal rapor açılır.
5. Kaynak tarama tamamlanmadan panel e-posta sırasını tüketmez. Tamamlanınca
   aynı günlük run devam eder. Yarım kalan gönderim aynı donmuş kapsamı
   kullanır; yeni 25 kişi seçilmez. Kaydedilmiş alıcı hataları otomatik tekrar
   gönderilmez; panelden elle yeniden denenir.

## Yerel kanıtlar

- `local-data/daily-sop-supervisor-state.json`: faz, deneme ve hata yığını.
- `local-data/daily-sop-checkpoint-YYYY-MM-DD.json`: tamamlanan kayıtlar.
- `local-data/logs/echr-daily-supervisor-YYYY-MM-DD.log`: süreç çıkışları.
- `local-data/logs/echr-daily-sop-YYYY-MM-DD-attempt-*.log`: stdout/stderr.
- `local-data/daily-sop-reports/YYYY-MM-DD/`: varsa fatal Node raporları.

`-Preflight` yalnız yerel yapılandırmayı kontrol eder; tarama, D1 yazımı veya
e-posta göndermez. Testler:

```powershell
node --test db-old/*.test.js scripts/echr-daily-supervisor.test.cjs
```

Bilgisayarın açık/oturumun kullanılabilir ve ağın erişilebilir olması gerekir.
Harici SOP/D1/e-posta hizmetinin kesintisizliği garanti edilemez. Süre sınırı
veya sürekli kesintide görev başarı raporlamaz; checkpoint ve hata kanıtı
korunur. Kurulum günü gündüz taraması başlatılmaz; ilk yeni tetik ertesi gece.
