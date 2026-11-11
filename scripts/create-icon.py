from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'assets'
root.mkdir(exist_ok=True)
image = Image.new('RGBA', (1024, 1024))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 1023, 1023), radius=224, fill='#5363e9')
draw.polygon([(240, 190), (784, 190), (784, 350), (400, 350), (400, 432), (720, 432), (720, 592), (400, 592), (400, 674), (784, 674), (784, 834), (240, 834)], fill='#ffffff')
image = image.resize((256, 256), Image.Resampling.LANCZOS)
image.save(root / 'icon.png')
image.save(root / 'app.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
