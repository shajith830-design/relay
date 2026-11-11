from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from imageio_ffmpeg import get_ffmpeg_exe

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "Relay-1-Minute-Marketing-Video-Vertical-1080p.mp4"
MUSIC = ROOT / "scripts" / "relay-music.wav"
VOICEOVER = ROOT / "scripts" / "relay-marketing-voiceover.wav"
VOICE_SCRIPT = ROOT / "scripts" / "generate_relay_marketing_voiceover.ps1"
LOGO = ROOT / "public" / "assets" / "Futuristic RA Tech Monogram Logo.png"

WIDTH, HEIGHT, FPS, DURATION = 1080, 1920, 30, 60
FONT_REG = "C:/Windows/Fonts/arial.ttf"
FONT_BOLD = "C:/Windows/Fonts/arialbd.ttf"
INK = (7, 13, 30)
WHITE = (247, 249, 255)
MUTED = (162, 177, 201)
CYAN = (53, 224, 242)
BLUE = (68, 116, 255)
PURPLE = (150, 106, 255)
GREEN = (93, 231, 173)
ORANGE = (255, 171, 90)
PINK = (255, 104, 151)


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def ease(value):
    value = max(0.0, min(1.0, value))
    return value * value * (3 - 2 * value)


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def tint(color, background, opacity):
    return tuple(int(foreground * opacity + base * (1 - opacity)) for foreground, base in zip(color, background))


def center_text(draw, text, y, face, color, x=WIDTH // 2, spacing=16):
    box = draw.multiline_textbbox((0, 0), text, font=face, spacing=spacing, align="center")
    draw.multiline_text(
        (x - (box[2] - box[0]) / 2, y),
        text,
        font=face,
        fill=color,
        spacing=spacing,
        align="center",
    )


def make_background():
    rows = np.arange(HEIGHT, dtype=np.float32)[:, None]
    top = np.array((8, 15, 34), dtype=np.float32)
    bottom = np.array((12, 27, 49), dtype=np.float32)
    ratio = rows / (HEIGHT - 1)
    pixels = (top * (1 - ratio[:, :, None]) + bottom * ratio[:, :, None])
    pixels = np.repeat(pixels, WIDTH, axis=1).astype(np.uint8)
    image = Image.fromarray(pixels).convert("RGBA")
    grid = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(grid)
    for x in range(0, WIDTH, 72):
        draw.line((x, 0, x, HEIGHT), fill=(177, 208, 255, 9), width=1)
    for y in range(0, HEIGHT, 72):
        draw.line((0, y, WIDTH, y), fill=(177, 208, 255, 9), width=1)
    return Image.alpha_composite(image, grid)


def make_glow(color, size=560):
    axis = np.linspace(-1, 1, size, dtype=np.float32)
    xx, yy = np.meshgrid(axis, axis)
    radius = np.sqrt(xx * xx + yy * yy)
    alpha = (np.maximum(0, 1 - radius) ** 2 * 64).astype(np.uint8)
    pixels = np.zeros((size, size, 4), dtype=np.uint8)
    pixels[:, :, :3] = color
    pixels[:, :, 3] = alpha
    return Image.fromarray(pixels)


BASE = make_background()
GLOWS = {color: make_glow(color) for color in (CYAN, BLUE, PURPLE, GREEN, ORANGE, PINK)}

logo_source = Image.open(LOGO).convert("RGB")
logo_source = logo_source.crop((235, 350, 1020, 850)).resize((118, 76), Image.Resampling.LANCZOS)
logo_pixels = np.array(logo_source)
logo_alpha = np.where(np.max(logo_pixels, axis=2) > 42, 255, 0).astype(np.uint8)
LOGO_MARK = Image.fromarray(np.dstack((logo_pixels, logo_alpha)))


SCENES = [
    {"lines": ("Every customer", "journey deserves", "a clear path."), "accent": CYAN},
    {"lines": ("Less chasing.", "More momentum."), "accent": PURPLE},
    {"lines": ("Make the next", "step feel clear."), "accent": GREEN},
    {"lines": ("Keep your team", "moving together."), "accent": ORANGE},
    {"lines": ("See readiness", "at a glance."), "accent": PINK},
    {"lines": ("Give onboarding", "a better rhythm."), "accent": CYAN},
]


def draw_brand(image, scene_time, accent):
    draw = ImageDraw.Draw(image)
    image.alpha_composite(LOGO_MARK, (64, 70))
    draw.text((205, 78), "Relay", font=font(42, True), fill=WHITE)
    draw.text((208, 126), "AUTOMATION", font=font(16, True), fill=MUTED)
    rounded(draw, (790, 90, 1018, 144), 27, (24, 35, 55), (42, 51, 70))
    draw.text((826, 105), "CUSTOMER OPS", font=font(17, True), fill=(226, 236, 252))


def draw_headline(image, lines, local_time, accent):
    draw = ImageDraw.Draw(image)
    line_height = 126
    top = 300 if len(lines) == 2 else 260
    for index, text in enumerate(lines):
        reveal = ease((local_time - 0.38 - index * 0.28) / 0.55)
        if reveal <= 0:
            continue
        y = top + index * line_height + int((1 - reveal) * 54)
        face = font(84 if len(text) < 21 else 77, True)
        color = accent if index == len(lines) - 1 else WHITE
        layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        layer_draw = ImageDraw.Draw(layer)
        center_text(layer_draw, text, y, face, (*color, int(255 * reveal)))
        image.alpha_composite(layer)
    if local_time > 1.15:
        draw = ImageDraw.Draw(image)
        width = int(240 * ease((local_time - 1.1) / 0.65))
        y = top + len(lines) * line_height + 12
        draw.rounded_rectangle((WIDTH // 2 - width // 2, y, WIDTH // 2 + width // 2, y + 5), radius=3, fill=(*accent, 225))


def card_shell(image, box, accent, lift=0):
    x0, y0, x1, y1 = box
    y0 += lift
    y1 += lift
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    rounded(shadow_draw, (x0 + 8, y0 + 22, x1 + 8, y1 + 22), 34, (0, 0, 0, 90))
    image.alpha_composite(shadow)
    draw = ImageDraw.Draw(image)
    rounded(draw, (x0, y0, x1, y1), 34, (14, 26, 48), (42, 52, 72), 2)
    rounded(draw, (x0 + 1, y0 + 1, x0 + 9, y1 - 1), 5, accent)
    return draw, y0


def draw_flow(image, local_time, accent, y=1240):
    draw = ImageDraw.Draw(image)
    points = [(138, y + 110), (350, y + 26), (556, y + 160), (770, y + 58), (948, y + 116)]
    draw.line(points, fill=(*accent, 65), width=5, joint="curve")
    for index, (x, py) in enumerate(points):
        pulse = 0.5 + 0.5 * np.sin(local_time * 2.4 - index * 0.8)
        radius = int(10 + 7 * pulse)
        draw.ellipse((x - radius - 7, py - radius - 7, x + radius + 7, py + radius + 7), fill=tint(accent, INK, 0.3))
        draw.ellipse((x - radius, py - radius, x + radius, py + radius), fill=accent)
    for index in range(5):
        progress = (local_time * 0.18 + index * 0.2) % 1
        segment = progress * (len(points) - 1)
        start = int(segment)
        blend = segment - start
        x = int(points[start][0] * (1 - blend) + points[min(start + 1, len(points) - 1)][0] * blend)
        py = int(points[start][1] * (1 - blend) + points[min(start + 1, len(points) - 1)][1] * blend)
        draw.ellipse((x - 7, py - 7, x + 7, py + 7), fill=(255, 255, 255, 245))


def draw_scattered_cards(image, local_time, accent):
    entries = [
        ("CUSTOMER SETUP", "Workspace details", -200, 990, 92),
        ("TEAM HANDOFF", "Owner assigned", 1110, 1140, 92),
        ("NEXT STEP", "Launch review", -170, 1305, 92),
    ]
    for i, (label, detail, start_x, y, target_x) in enumerate(entries):
        progress = ease((local_time - 0.4 - i * 0.26) / 1.35)
        x = int(start_x + (target_x - start_x) * progress)
        y += int(18 * np.sin(local_time * 2 - i))
        draw, y0 = card_shell(image, (x, y, x + 750, y + 154), accent, int((1 - progress) * 48))
        draw.text((x + 42, y0 + 27), label, font=font(17, True), fill=accent)
        draw.text((x + 42, y0 + 61), detail, font=font(27, True), fill=WHITE)
        draw.ellipse((x + 660, y0 + 52, x + 706, y0 + 98), fill=(*accent, 38), outline=(*accent, 160), width=2)
        draw.line((x + 674, y0 + 76, x + 684, y0 + 86, x + 700, y0 + 65), fill=accent, width=4)
    draw_flow(image, local_time, accent, y=1510)


def draw_portal(image, local_time, accent):
    progress = ease((local_time - 0.25) / 0.85)
    lift = int((1 - progress) * 85 + 14 * np.sin(local_time * 1.4))
    draw, y0 = card_shell(image, (104, 900, 976, 1638), accent, lift)
    draw.text((158, y0 + 48), "ACME  /  IMPLEMENTATION", font=font(17, True), fill=MUTED)
    draw.text((158, y0 + 92), "Launch checklist", font=font(37, True), fill=WHITE)
    draw.text((158, y0 + 147), "Your team's next steps, all in one place.", font=font(22), fill=MUTED)
    rounded(draw, (158, y0 + 207, 920, y0 + 223), 8, (43, 56, 78))
    bar = int(548 * ease((local_time - 0.8) / 2.4))
    rounded(draw, (158, y0 + 207, 158 + bar, y0 + 223), 8, accent)
    draw.text((158, y0 + 249), f"{int(bar / 5.48)}% ready", font=font(18, True), fill=accent)
    rows = [
        ("01", "Confirm project goals", "Done"),
        ("02", "Configure your workspace", "In progress"),
        ("03", "Review launch readiness", "Up next"),
    ]
    for index, (number, title, status) in enumerate(rows):
        ry = y0 + 312 + index * 116
        rounded(draw, (150, ry, 930, ry + 92), 20, (27, 40, 59))
        draw.ellipse((176, ry + 24, 220, ry + 68), fill=(*accent, 37), outline=(*accent, 105), width=1)
        draw.text((184, ry + 33), number, font=font(17, True), fill=accent)
        draw.text((244, ry + 19), title, font=font(23, True), fill=WHITE)
        draw.text((244, ry + 53), status.upper(), font=font(14, True), fill=MUTED)
        if index < int(ease((local_time - 1.4) / 3.0) * 2.2):
            draw.ellipse((872, ry + 31, 900, ry + 59), fill=accent)
            draw.line((879, ry + 44, 885, ry + 50, 895, ry + 38), fill=INK, width=3)


def draw_team(image, local_time, accent):
    draw, y0 = card_shell(image, (94, 1030, 986, 1550), accent, int(18 * np.sin(local_time * 1.35)))
    draw.text((150, y0 + 42), "IMPLEMENTATION TEAM", font=font(17, True), fill=MUTED)
    draw.text((150, y0 + 80), "Everyone in sync.", font=font(34, True), fill=WHITE)
    avatars = [("AM", CYAN), ("JT", PURPLE), ("SK", GREEN)]
    for i, (initials, color) in enumerate(avatars):
        x = 172 + i * 132
        y = y0 + 202
        draw.ellipse((x, y, x + 88, y + 88), fill=(*color, 46), outline=(*color, 200), width=3)
        draw.text((x + 20, y + 28), initials, font=font(23, True), fill=WHITE)
        draw.ellipse((x + 64, y + 64, x + 88, y + 88), fill=GREEN, outline=(14, 26, 48), width=4)
    draw.text((150, y0 + 330), "Clear owners  ·  Clear next actions", font=font(23, True), fill=(220, 231, 248))
    rounded(draw, (150, y0 + 393, 930, y0 + 414), 10, (43, 56, 78))
    width = int(650 * ease((local_time - 0.7) / 3.0))
    rounded(draw, (150, y0 + 393, 150 + width, y0 + 414), 10, accent)
    draw_flow(image, local_time + 2.2, accent, y=1585)


def draw_readiness(image, local_time, accent):
    draw, y0 = card_shell(image, (96, 1010, 984, 1586), accent, int(15 * np.sin(local_time)))
    draw.text((152, y0 + 42), "WORKSPACE OVERVIEW", font=font(17, True), fill=MUTED)
    draw.text((152, y0 + 83), "Implementation health", font=font(31, True), fill=WHITE)
    rows = [
        ("Northstar Labs", "On track", CYAN, 0.78),
        ("Juniper Cloud", "Needs attention", ORANGE, 0.52),
        ("Atlas Systems", "Moving forward", GREEN, 0.91),
    ]
    for index, (name, state, color, value) in enumerate(rows):
        ry = y0 + 166 + index * 122
        rounded(draw, (146, ry, 934, ry + 94), 19, (27, 40, 59))
        draw.text((176, ry + 19), name, font=font(23, True), fill=WHITE)
        draw.text((176, ry + 56), state, font=font(16, True), fill=color)
        rounded(draw, (632, ry + 40, 890, ry + 54), 7, (43, 56, 78))
        grow = int(258 * value * ease((local_time - 0.55 - index * 0.25) / 1.5))
        rounded(draw, (632, ry + 40, 632 + grow, ry + 54), 7, color)
    draw.text((152, y0 + 548), "A clearer view of work in motion.", font=font(19), fill=MUTED)


def draw_close(image, local_time, accent):
    draw = ImageDraw.Draw(image)
    draw.ellipse((290, 1010, 790, 1510), outline=tint(accent, INK, 0.42), width=2)
    draw.ellipse((346, 1066, 734, 1454), outline=tint(accent, INK, 0.28), width=2)
    pulse = int(10 * np.sin(local_time * 2.2))
    mark = LOGO_MARK.resize((236 + pulse, 152 + pulse // 2), Image.Resampling.LANCZOS)
    image.alpha_composite(mark, (WIDTH // 2 - mark.width // 2, 1114 - pulse // 4))
    draw = ImageDraw.Draw(image)
    draw.text((WIDTH // 2 - 95, 1316), "Relay", font=font(58, True), fill=WHITE)
    draw.text((WIDTH // 2 - 92, 1388), "AUTOMATION", font=font(19, True), fill=MUTED)
    reveal = ease((local_time - 0.7) / 1.0)
    width = int(650 * reveal)
    x0 = WIDTH // 2 - width // 2
    rounded(draw, (x0, 1514, x0 + width, 1624), 35, accent)
    if reveal > 0.2:
        draw.text((WIDTH // 2 - 136, 1547), "BOOK A DEMO  →", font=font(25, True), fill=INK)
    draw.text((WIDTH // 2, 1690), "relayautomation.tech", font=font(22, True), fill=(222, 233, 250), anchor="mm")


def draw_scene(scene_index, local_time, frame_index):
    scene = SCENES[scene_index]
    accent = scene["accent"]
    image = BASE.copy()

    drift_x = int(100 + 50 * np.sin(local_time * 0.55 + scene_index))
    drift_y = int(630 + 85 * np.cos(local_time * 0.48 + scene_index))
    image.alpha_composite(GLOWS[accent], (drift_x - 280, drift_y - 280))
    image.alpha_composite(GLOWS[BLUE], (750 - drift_x // 3, 380 + int(22 * np.sin(local_time))))

    draw_brand(image, local_time, accent)
    draw_headline(image, scene["lines"], local_time, accent)

    if scene_index == 0:
        draw_flow(image, local_time, accent)
        draw = ImageDraw.Draw(image)
        draw.text((WIDTH // 2, 1550), "A clearer way to move customer work forward.", font=font(23), fill=MUTED, anchor="mm")
    elif scene_index == 1:
        draw_scattered_cards(image, local_time, accent)
    elif scene_index == 2:
        draw_portal(image, local_time, accent)
    elif scene_index == 3:
        draw_team(image, local_time, accent)
    elif scene_index == 4:
        draw_readiness(image, local_time, accent)
    else:
        draw_close(image, local_time, accent)

    draw = ImageDraw.Draw(image)
    for index in range(18):
        x = (index * 191 + frame_index * (2 + index % 4)) % WIDTH
        y = (index * 307 + frame_index * (1 + index % 3)) % HEIGHT
        alpha = int(35 + 35 * (0.5 + 0.5 * np.sin(frame_index * 0.09 + index)))
        draw.ellipse((x, y, x + 3, y + 3), fill=(*accent, alpha))

    edge = min(local_time / 0.28, (10 - local_time) / 0.22, 1)
    if edge < 1:
        fade = Image.new("RGBA", image.size, (3, 6, 17, int(255 * (1 - ease(edge)))))
        image.alpha_composite(fade)
    return np.asarray(image.convert("RGB"), dtype=np.uint8)


def generate_voiceover():
    subprocess.run(
        [
            "pwsh.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(VOICE_SCRIPT),
            "-OutputPath",
            str(VOICEOVER),
        ],
        check=True,
    )
    if not VOICEOVER.is_file():
        raise FileNotFoundError(f"Voiceover was not generated: {VOICEOVER}")


def main():
    if not MUSIC.is_file():
        raise FileNotFoundError(f"Music bed not found: {MUSIC}")
    generate_voiceover()
    ffmpeg = get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s:v",
        f"{WIDTH}x{HEIGHT}",
        "-r",
        str(FPS),
        "-i",
        "pipe:0",
        "-i",
        str(MUSIC),
        "-i",
        str(VOICEOVER),
        "-filter_complex",
        "[1:a]volume=0.16[bed];[2:a]volume=1.0[voice];[bed][voice]amix=inputs=2:duration=first:weights='1 1.55':normalize=0,alimiter=limit=0.95[aout]",
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-t",
        str(DURATION),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "19",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(OUTPUT),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        total_frames = FPS * DURATION
        for frame_index in range(total_frames):
            scene_index = min(frame_index // (FPS * 10), len(SCENES) - 1)
            local_time = (frame_index % (FPS * 10)) / FPS
            process.stdin.write(draw_scene(scene_index, local_time, frame_index).tobytes())
            if frame_index and frame_index % (FPS * 10) == 0:
                print(f"Rendered {frame_index // FPS}s / {DURATION}s", flush=True)
        process.stdin.close()
        return_code = process.wait()
        if return_code:
            raise RuntimeError(f"ffmpeg exited with code {return_code}")
    except Exception:
        process.kill()
        raise

    print(f"Created {OUTPUT}")


if __name__ == "__main__":
    main()
