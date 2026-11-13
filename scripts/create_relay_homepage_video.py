from pathlib import Path
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from imageio_ffmpeg import get_ffmpeg_exe

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "assets" / "relay-home-overview.mp4"
POSTER = ROOT / "public" / "assets" / "relay-home-video-poster.png"
MUSIC = ROOT / "scripts" / "relay-music.wav"
VOICEOVER = ROOT / "scripts" / "relay-homepage-voiceover.wav"
VOICE_SCRIPT = ROOT / "scripts" / "generate_relay_homepage_voiceover.ps1"

WIDTH, HEIGHT, FPS, DURATION = 1920, 1080, 24, 30
FONT_REG = "C:/Windows/Fonts/arial.ttf"
FONT_BOLD = "C:/Windows/Fonts/arialbd.ttf"
INK = (15, 42, 66)
MUTED = (92, 116, 139)
BLUE = (2, 132, 199)
CYAN = (56, 189, 248)
GREEN = (22, 137, 98)
AMBER = (208, 126, 28)
WHITE = (255, 255, 255)
PALE = (244, 249, 253)


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def clamp(value):
    return max(0.0, min(1.0, value))


def ease(value):
    value = clamp(value)
    return value * value * (3 - 2 * value)


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make_background():
    rows = np.arange(HEIGHT, dtype=np.float32)[:, None]
    top = np.array((248, 251, 255), dtype=np.float32)
    bottom = np.array((235, 245, 253), dtype=np.float32)
    ratio = rows / (HEIGHT - 1)
    pixels = (top * (1 - ratio[:, :, None]) + bottom * ratio[:, :, None])
    image = Image.fromarray(np.repeat(pixels, WIDTH, axis=1).astype(np.uint8)).convert("RGBA")
    decor = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(decor)
    for x in range(-120, WIDTH + 120, 100):
        draw.line((x, 0, x + 250, HEIGHT), fill=(68, 142, 194, 12), width=1)
    draw.ellipse((1370, -340, 2200, 490), fill=(56, 189, 248, 18))
    draw.ellipse((-380, 660, 430, 1470), fill=(2, 132, 199, 13))
    return Image.alpha_composite(image, decor).convert("RGB")


BASE = make_background()


def draw_brand(draw, dark=False):
    color = WHITE if dark else INK
    small = (194, 218, 237) if dark else MUTED
    rounded(draw, (105, 78, 157, 130), 16, BLUE)
    draw.text((131, 104), "R", font=font(32, True), fill=WHITE, anchor="mm")
    draw.text((177, 82), "Relay", font=font(32, True), fill=color)
    draw.text((179, 116), "AUTOMATION", font=font(12, True), fill=small)


def draw_title(draw, title, subtitle, dark=False):
    main = WHITE if dark else INK
    sub = (200, 220, 236) if dark else MUTED
    draw.text((WIDTH // 2, 176), title, font=font(52, True), fill=main, anchor="mm")
    draw.text((WIDTH // 2, 235), subtitle, font=font(25), fill=sub, anchor="mm")


def draw_icon(draw, center, kind, color, radius=38):
    x, y = center
    pale = tuple(int(channel * 0.11 + 255 * 0.89) for channel in color)
    outline = tuple(int(channel * 0.44 + 255 * 0.56) for channel in color)
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=pale, outline=outline, width=3)
    if kind == "check":
        draw.line((x - 17, y, x - 4, y + 13, x + 21, y - 16), fill=color, width=7, joint="curve")
    elif kind == "person":
        draw.ellipse((x - 9, y - 20, x + 9, y - 2), fill=color)
        draw.rounded_rectangle((x - 21, y + 6, x + 21, y + 23), radius=9, fill=color)
    elif kind == "plus":
        draw.line((x - 17, y, x + 17, y), fill=color, width=6)
        draw.line((x, y - 17, x, y + 17), fill=color, width=6)
    elif kind == "clock":
        draw.ellipse((x - 20, y - 20, x + 20, y + 20), outline=color, width=5)
        draw.line((x, y - 12, x, y + 1, x + 11, y + 8), fill=color, width=5, joint="curve")
    elif kind == "spark":
        points = [(x, y - 24), (x + 7, y - 7), (x + 24, y), (x + 7, y + 7),
                  (x, y + 24), (x - 7, y + 7), (x - 24, y), (x - 7, y - 7)]
        draw.polygon(points, fill=color)
    elif kind == "document":
        draw.rounded_rectangle((x - 16, y - 22, x + 16, y + 22), radius=4, outline=color, width=4)
        draw.line((x - 8, y - 6, x + 8, y - 6), fill=color, width=3)
        draw.line((x - 8, y + 3, x + 8, y + 3), fill=color, width=3)
        draw.line((x - 8, y + 12, x + 4, y + 12), fill=color, width=3)


def draw_flow_line(draw, start, end, color, width=7):
    draw.line((*start, *end), fill=color, width=width)
    x1, y1 = start
    x2, y2 = end
    draw.polygon([(x2, y2), (x2 - 22, y2 - 13), (x2 - 22, y2 + 13)], fill=color)


def draw_scene(scene_index, local_time):
    image = BASE.copy()
    draw = ImageDraw.Draw(image)
    draw_brand(draw)
    scenes = [
        ("The contract is signed.", "Now every handoff matters."),
        ("Bring the setup work together.", "Requests, owners, and next steps in one clear flow."),
        ("Start with a process you can reuse.", "Keep each implementation consistent from kickoff to launch."),
        ("Give customers a clear next step.", "Collect the setup information your team needs."),
        ("See what needs attention.", "Find missing details and work waiting on follow-up."),
        ("Make every next step clear.", "Relay · Customer implementation readiness"),
    ]
    title, subtitle = scenes[scene_index]
    draw_title(draw, title, subtitle)

    entrance = ease(local_time / 0.75)
    bob = int(5 * np.sin(local_time * 2.2))
    if scene_index == 0:
        boxes = [(260, 440, 690, 650), (1230, 440, 1660, 650)]
        for box in boxes:
            rounded(draw, box, 34, WHITE, (215, 229, 239), 2)
        draw_icon(draw, (390, 545), "document", BLUE, 43)
        draw.text((462, 522), "SIGNED", font=font(22, True), fill=BLUE, anchor="lm")
        draw.text((462, 567), "Customer agreement", font=font(26, True), fill=INK, anchor="lm")
        draw_icon(draw, (1360, 545), "spark", GREEN, 43)
        draw.text((1430, 522), "NEXT", font=font(22, True), fill=GREEN, anchor="lm")
        draw.text((1430, 567), "Customer go-live", font=font(26, True), fill=INK, anchor="lm")
        draw_flow_line(draw, (740, 545), (1170, 545), (90, 163, 209), 8)
        for index, (label, x) in enumerate((("SETUP", 860), ("OWNERS", 960), ("LAUNCH", 1060))):
            y = 520 + (index % 2) * 50 + bob
            draw.ellipse((x - 11, y - 11, x + 11, y + 11), fill=CYAN)
            draw.text((x, 607), label, font=font(13, True), fill=MUTED, anchor="mm")
    elif scene_index == 1:
        center = (960, 520 + bob)
        cards = [
            ("Setup information", "document", (500, 385, 870, 495), BLUE),
            ("Team ownership", "person", (1050, 385, 1420, 495), GREEN),
            ("Next action", "clock", (775, 655, 1145, 765), AMBER),
        ]
        for label, icon, box, color in cards:
            rounded(draw, box, 27, WHITE, (219, 231, 240), 2)
            draw_icon(draw, (box[0] + 52, (box[1] + box[3]) // 2), icon, color, 28)
            draw.text((box[0] + 101, (box[1] + box[3]) // 2), label, font=font(23, True), fill=INK, anchor="lm")
            draw.line(((box[0] + box[2]) // 2, box[3], *center), fill=(136, 182, 211), width=4)
        draw.ellipse((center[0] - 25, center[1] - 25, center[0] + 25, center[1] + 25), fill=BLUE)
        draw.ellipse((center[0] - 9, center[1] - 9, center[0] + 9, center[1] + 9), fill=WHITE)
    elif scene_index == 2:
        labels = [
            ("01", "Confirm goals", "Implementation lead", BLUE),
            ("02", "Configure setup", "Assigned specialist", CYAN),
            ("03", "Review readiness", "Team and customer", GREEN),
        ]
        left, top, width, gap = 320, 390, 390, 105
        for index, (number, title_text, owner, color) in enumerate(labels):
            y = top + index * gap + int((1 - entrance) * 70)
            x = left + index * (width + gap)
            rounded(draw, (x, y, x + width, y + 76), 24, WHITE, (216, 231, 241), 2)
            draw.ellipse((x + 19, y + 18, x + 59, y + 58), fill=(*color, 32))
            draw.text((x + 39, y + 38), number, font=font(14, True), fill=color, anchor="mm")
            draw.text((x + 78, y + 25), title_text, font=font(20, True), fill=INK)
            draw.text((x + 78, y + 52), owner, font=font(14), fill=MUTED)
            if index < 2:
                draw.line((x + width - 18, y + 38, x + width + gap + 20, y + 38), fill=(120, 175, 207), width=4)
        draw_icon(draw, (960, 794), "check", GREEN, 31)
        draw.text((1010, 794), "One checked workflow. Ready to reuse.", font=font(20, True), fill=INK, anchor="lm")
    elif scene_index == 3:
        rounded(draw, (610, 340, 1310, 790), 42, WHITE, (214, 231, 239), 2)
        draw.ellipse((916, 382, 1004, 470), fill=(221, 246, 238))
        draw_icon(draw, (960, 426), "document", GREEN, 33)
        draw.text((960, 512), "Customer setup", font=font(31, True), fill=INK, anchor="mm")
        draw.text((960, 559), "Share the details needed to get started", font=font(18), fill=MUTED, anchor="mm")
        for index, (label, icon, color) in enumerate(
            (("Project contact", "person", BLUE), ("Workspace details", "document", CYAN))
        ):
            y = 604 + index * 75
            rounded(draw, (690, y, 1230, y + 58), 18, PALE, (225, 235, 243), 1)
            draw_icon(draw, (726, y + 29), icon, color, 18)
            draw.text((765, y + 29), label, font=font(19, True), fill=INK, anchor="lm")
            draw.ellipse((1174, y + 19, 1194, y + 39), fill=GREEN)
            draw.line((1179, y + 29, 1184, y + 34, 1190, y + 24), fill=WHITE, width=3)
    elif scene_index == 4:
        rounded(draw, (340, 370, 1580, 725), 38, WHITE, (216, 231, 240), 2)
        draw_icon(draw, (430, 465), "document", BLUE, 43)
        draw.text((505, 437), "Setup information", font=font(26, True), fill=INK)
        draw.text((505, 481), "Customer contact details still needed", font=font(18), fill=MUTED)
        rounded(draw, (1260, 424, 1510, 482), 24, (255, 246, 228))
        draw.text((1385, 453), "NEEDS FOLLOW-UP", font=font(14, True), fill=AMBER, anchor="mm")
        draw.line((430, 545, 1490, 545), fill=(229, 237, 243), width=2)
        draw_icon(draw, (442, 625), "person", GREEN, 31)
        draw.text((500, 604), "Next action", font=font(16, True), fill=MUTED)
        draw.text((500, 648), "Request the required customer detail", font=font(22, True), fill=INK)
        rounded(draw, (1265, 593, 1508, 661), 21, BLUE)
        draw.text((1386, 627), "Keep it moving", font=font(17, True), fill=WHITE, anchor="mm")
    else:
        draw_brand(draw, dark=True)
        overlay = Image.new("RGB", image.size, (14, 43, 68))
        image = Image.blend(image, overlay, 0.91)
        draw = ImageDraw.Draw(image)
        draw_brand(draw, dark=True)
        draw.ellipse((722, 324, 1198, 800), outline=(79, 177, 222), width=2)
        draw.ellipse((772, 374, 1148, 750), outline=(81, 159, 199), width=2)
        draw.ellipse((827, 429, 1093, 695), fill=(2, 132, 199))
        draw.text((960, 562), "R", font=font(142, True), fill=WHITE, anchor="mm")
        draw.text((960, 812), "Relay", font=font(64, True), fill=WHITE, anchor="mm")
        draw.text((960, 872), "CUSTOMER IMPLEMENTATION READINESS", font=font(18, True),
                  fill=(187, 217, 237), anchor="mm")
        draw.text((960, 950), "relayautomation.tech", font=font(19), fill=(218, 237, 249), anchor="mm")
        return image.convert("RGB")

    fade = min(ease(local_time / 0.25), ease((5 - local_time) / 0.25))
    if fade < 1:
        veil = Image.new("RGB", image.size, WHITE)
        image = Image.blend(image, veil, 1 - fade)
    return image.convert("RGB")


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
        raise FileNotFoundError(f"Music bed was not found: {MUSIC}")
    generate_voiceover()
    POSTER.parent.mkdir(parents=True, exist_ok=True)
    draw_scene(0, 1.0).save(POSTER, format="PNG", optimize=True)

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
        "[1:a]volume=0.11[bed];[2:a]volume=1.0[voice];"
        "[bed][voice]amix=inputs=2:duration=first:weights='1 1.4':normalize=0,"
        "alimiter=limit=0.95[aout]",
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
        "21",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(OUTPUT),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        total_frames = FPS * DURATION
        for frame_index in range(total_frames):
            scene_index = min(frame_index // (FPS * 5), 5)
            local_time = (frame_index % (FPS * 5)) / FPS
            frame = draw_scene(scene_index, local_time)
            process.stdin.write(np.asarray(frame).tobytes())
        process.stdin.close()
        return_code = process.wait()
        if return_code:
            raise RuntimeError(f"ffmpeg exited with code {return_code}")
    except Exception:
        process.kill()
        raise
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
    VOICEOVER.unlink(missing_ok=True)
    print(f"Created {OUTPUT}")
    print(f"Created {POSTER}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Homepage video generation failed: {error}", file=sys.stderr)
        raise
