import os
import json

base_dir = r"d:\fcdownloader\extension\_locales"
os.makedirs(base_dir, exist_ok=True)

# List of locales based on your supported languages list + standard codes
locales = {
    "en": "Save media you own, control, or have permission to access from supported websites.",
    "es": "Guarda los medios que posees, controlas o tienes permiso para acceder desde sitios web compatibles.",
    "fr": "Enregistrez les médias que vous possédez, contrôlez ou avez l'autorisation d'accéder depuis les sites Web pris en charge.",
    "de": "Speichern Sie Medien, die Sie besitzen, kontrollieren oder auf die Sie über unterstützte Websites zugreifen dürfen.",
    "pt": "Salve a mídia que você possui, controla ou tem permissão para acessar em sites suportados.",
    "it": "Salva i file multimediali che possiedi, controlli o a cui hai il permesso di accedere dai siti Web supportati.",
    "ja": "サポートされているウェブサイトから、所有、管理、またはアクセス許可のあるメディアを保存します。",
    "ko": "지원되는 웹 사이트에서 소유, 제어 또는 액세스 권한이 있는 미디어를 저장합니다.",
    "zh_CN": "保存您拥有、控制或有权从支持的网站访问的媒体。",
    "zh_TW": "保存您擁有、控制或有權從支持的網站訪問的媒體。",
    "hi": "समर्थित वेबसाइटों से उस मीडिया को सहेजें जिसका आप स्वामित्व रखते हैं, नियंत्रित करते हैं, या जिस तक पहुंचने की आपके पास अनुमति है।",
    "ar": "احفظ الوسائط التي تمتلكها أو تتحكم فيها أو لديك إذن بالوصول إليها من مواقع الويب المدعومة.",
    "ru": "Сохраняйте медиафайлы, которыми вы владеете, управляете или к которым имеете разрешение на доступ с поддерживаемых веб-сайтов.",
    "id": "Simpan media yang Anda miliki, kontrol, atau memiliki izin untuk mengakses dari situs web yang didukung.",
    "tr": "Desteklenen web sitelerinden sahip olduğunuz, kontrol ettiğiniz veya erişme izniniz olan medyayı kaydedin.",
    "vi": "Lưu phương tiện mà bạn sở hữu, kiểm soát hoặc có quyền truy cập từ các trang web được hỗ trợ.",
    "th": "บันทึกสื่อที่คุณเป็นเจ้าของ ควบคุม หรือได้รับอนุญาตให้เข้าถึงจากเว็บไซต์ที่รองรับ"
}

for loc, desc in locales.items():
    loc_dir = os.path.join(base_dir, loc)
    os.makedirs(loc_dir, exist_ok=True)
    msgs = {
        "extensionName": {
            "message": "FCDownloader"
        },
        "extensionDescription": {
            "message": desc
        }
    }
    with open(os.path.join(loc_dir, "messages.json"), "w", encoding="utf-8") as f:
        json.dump(msgs, f, indent=2, ensure_ascii=False)

print("Created all locales successfully.")
