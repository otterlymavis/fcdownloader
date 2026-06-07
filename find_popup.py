from PIL import Image

img = Image.open('screenshot.png').convert('RGB')
w, h = img.size

left = w
right = 0
top = h
bottom = 0
white_pixels = []

for y in range(0, h, 10):
    for x in range(int(w * 0.4), w, 10):
        r, g, b = img.getpixel((x, y))
        if r > 245 and g > 245 and b > 245:
            white_pixels.append((x, y))

if not white_pixels:
    print("No white pixels found.")
else:
    # Filter noise by only keeping rows/cols with a high density of white
    from collections import Counter
    xs = [p[0] for p in white_pixels]
    ys = [p[1] for p in white_pixels]
    x_counts = Counter(xs)
    y_counts = Counter(ys)
    
    # Keep x coordinates that have at least 20 white pixels in that column
    valid_xs = [x for x in x_counts if x_counts[x] > 20]
    valid_ys = [y for y in y_counts if y_counts[y] > 10]
    
    if valid_xs and valid_ys:
        print(f"Popup bounds approx: {min(valid_xs)}, {min(valid_ys)} to {max(valid_xs)}, {max(valid_ys)}")
    else:
        print("Not enough dense white areas.")
