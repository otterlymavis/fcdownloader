from PIL import Image, ImageFilter, ImageEnhance

icon = Image.open('icon.png').convert('RGBA')
screenshot = Image.open('store_screenshot.png').convert('RGBA')

# 300x300 Logo (just the icon scaled properly to fit a 300x300 canvas)
icon_300 = icon.resize((300, int(300 * icon.height / icon.width)), Image.Resampling.LANCZOS)
logo_canvas = Image.new('RGBA', (300, 300), (0, 0, 0, 0))
logo_canvas.paste(icon_300, (0, (300 - icon_300.height) // 2), icon_300)
logo_canvas.save('real_logo_300x300.png')

# Background generator function
def make_bg(w, h):
    sc_w, sc_h = screenshot.size
    ratio = max(w/sc_w, h/sc_h)
    new_w, new_h = int(sc_w * ratio), int(sc_h * ratio)
    bg = screenshot.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = (new_w - w) // 2
    top = (new_h - h) // 2
    bg = bg.crop((left, top, left+w, top+h))
    
    bg = bg.filter(ImageFilter.GaussianBlur(30))
    enhancer = ImageEnhance.Brightness(bg)
    bg = enhancer.enhance(0.4) # darken background
    return bg

# Small Promo (440x280)
small_bg = make_bg(440, 280)
icon_small_h = 160
icon_small_w = int(icon_small_h * icon.width / icon.height)
icon_small = icon.resize((icon_small_w, icon_small_h), Image.Resampling.LANCZOS)
small_bg.paste(icon_small, ((440-icon_small_w)//2, (280-icon_small_h)//2), icon_small)
small_bg.save('real_promo_440x280.png')

# Large Promo (1400x560)
large_bg = make_bg(1400, 560)

# Resize screenshot to fit height with some padding
sc_new_h = 460
sc_new_w = int(screenshot.size[0] * (sc_new_h / screenshot.size[1]))
sc_resized = screenshot.resize((sc_new_w, sc_new_h), Image.Resampling.LANCZOS)

# Create a drop shadow for the screenshot
shadow = Image.new('RGBA', (sc_new_w + 40, sc_new_h + 40), (0, 0, 0, 0))
from PIL import ImageDraw
draw = ImageDraw.Draw(shadow)
draw.rectangle([20, 20, sc_new_w + 20, sc_new_h + 20], fill=(0, 0, 0, 150))
shadow = shadow.filter(ImageFilter.GaussianBlur(15))
shadow.paste(sc_resized, (20, 20), sc_resized)

# Paste icon on left
icon_large_h = 300
icon_large_w = int(icon_large_h * icon.width / icon.height)
icon_large = icon.resize((icon_large_w, icon_large_h), Image.Resampling.LANCZOS)
icon_x = (1400 - sc_new_w - 100 - icon_large_w) // 2  # center in the remaining left space
icon_y = (560 - icon_large_h) // 2
large_bg.paste(icon_large, (icon_x, icon_y), icon_large)

# Paste screenshot + shadow on right
sc_x = 1400 - sc_new_w - 60
sc_y = (560 - sc_new_h) // 2 - 20 # Offset by 20 for shadow
large_bg.paste(shadow, (sc_x - 20, sc_y), shadow)

large_bg.save('real_promo_1400x560.png')
print("Generated updated promos!")
