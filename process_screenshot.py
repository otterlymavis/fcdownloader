from PIL import Image, ImageFilter, ImageDraw

# 1. Open and crop
img = Image.open('screenshot.png').convert('RGB')
# The original image is 2736 x 1824
# We want to crop a 1280x800 section. We'll start at x=1350, y=150 to cut out the top bar
crop_box = (1350, 150, 1350 + 1280, 150 + 800)
img_cropped = img.crop(crop_box)

# 2. Blur the background
img_blurred = img_cropped.filter(ImageFilter.GaussianBlur(15))

# 3. Find the popup bounding box
gray = img_cropped.convert('L')
mask_temp = gray.point(lambda p: 255 if p > 240 else 0)

left, top, right, bottom = 1280, 800, 0, 0
for y in range(0, 800, 5):
    for x in range(0, 1280, 5):
        if mask_temp.getpixel((x, y)) == 255:
            left = min(left, x)
            right = max(right, x)
            top = min(top, y)
            bottom = max(bottom, y)

# If no white pixels found (unlikely), fallback to a central box
if left >= right:
    left, top, right, bottom = 200, 100, 1080, 700

# 4. Create a soft mask based on the bounding box to keep the popup and its shadow sharp
solid_mask = Image.new('L', (1280, 800), 0)
draw = ImageDraw.Draw(solid_mask)
margin = 50
draw.rounded_rectangle([left - margin, top - margin, right + margin, bottom + margin], radius=30, fill=255)

# Soften the edges of the mask slightly
solid_mask = solid_mask.filter(ImageFilter.GaussianBlur(10))

# 5. Composite
final = Image.composite(img_cropped, img_blurred, solid_mask)
final.save('store_screenshot.png')
print("Saved store_screenshot.png")
