from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import create_relay_marketing_video_2 as video

ROOT = Path(__file__).resolve().parents[1]
POST = ROOT / "Relay-Marketing-Post-2.png"
CAPTION = ROOT / "Relay-Marketing-Post-2.txt"

CAMPAIGN = [
    {"lines": ("From kickoff", "to go-live."), "accent": video.CYAN},
    {"lines": ("Less chasing.", "More momentum."), "accent": video.PURPLE},
    {"lines": ("A clearer start", "for every customer."), "accent": video.GREEN},
]

VIDEO = ROOT / "Relay-30-Second-Marketing-Video-Vertical-1080p.mp4"
VOICEOVER = ROOT / "scripts" / "relay-campaign-2-voiceover.wav"
VOICE_SCRIPT = ROOT / "scripts" / "generate_relay_campaign_2_voiceover.ps1"

CAPTION_TEXT = """From kickoff to go-live, make every customer handoff easier to follow.

Relay brings customer requests, team ownership, and next steps into one clear workspace, so your team can spend less time chasing updates and more time moving implementations forward.

Explore the sample workspace or book a demo at relayautomation.tech.

#CustomerOnboarding #SaaS #CustomerSuccess #Implementation #RelayAutomation"""


def create_social_post():
    width, height = 1080, 1350
    image = video.make_background().resize((width, height), Image.Resampling.LANCZOS)
    glow = video.make_glow(video.CYAN, 500)
    image.alpha_composite(glow, (width - 360, 185))
    glow_purple = video.make_glow(video.PURPLE, 460)
    image.alpha_composite(glow_purple, (-230, 785))

    logo = Image.open(video.LOGO).convert("RGB")
    logo = logo.crop((235, 350, 1020, 850)).resize((118, 76), Image.Resampling.LANCZOS)
    logo_pixels = np.array(logo)
    alpha = np.where(np.max(logo_pixels, axis=2) > 42, 255, 0).astype(np.uint8)
    mark = Image.fromarray(np.dstack((logo_pixels, alpha)))
    image.alpha_composite(mark, (64, 62))

    draw = ImageDraw.Draw(image)
    draw.text((157, 69), "Relay", font=video.font(37, True), fill=video.WHITE)
    draw.text((159, 111), "AUTOMATION", font=video.font(14, True), fill=video.MUTED)
    video.rounded(draw, (700, 79, 1018, 131), 25, (24, 35, 55), (42, 51, 70))
    draw.text((859, 105), "B2B SAAS CUSTOMER ONBOARDING", font=video.font(13, True), fill=(226, 236, 252), anchor="mm")

    draw.text((68, 238), "THE JOURNEY", font=video.font(19, True), fill=video.CYAN)
    draw.text((62, 295), "From kickoff", font=video.font(74, True), fill=video.WHITE)
    draw.text((62, 382), "to go-live.", font=video.font(92, True), fill=video.CYAN)
    draw.rounded_rectangle((70, 506, 300, 514), radius=4, fill=video.CYAN)
    draw.text((68, 552), "Clear handoffs.", font=video.font(34, True), fill=video.WHITE)
    draw.text((68, 601), "Confident customers.", font=video.font(34, True), fill=video.WHITE)
    draw.text((68, 670), "One shared view for every next step.", font=video.font(25), fill=video.MUTED)

    # A compact workflow illustration anchors the message in the product.
    card = (64, 774, 1016, 1128)
    video.rounded(draw, card, 34, (14, 26, 48), (42, 52, 72), 2)
    draw.text((108, 815), "B2B SAAS CUSTOMER ONBOARDING", font=video.font(18, True), fill=video.MUTED)
    draw.text((108, 856), "Keep every handoff moving.", font=video.font(30, True), fill=video.WHITE)
    nodes = [(166, 1014), (414, 958), (660, 1031), (908, 970)]
    draw.line(nodes, fill=(43, 68, 97), width=7, joint="curve")
    draw.line(nodes[:3], fill=video.CYAN, width=7, joint="curve")
    for index, (x, y) in enumerate(nodes):
        accent = (video.CYAN, video.PURPLE, video.GREEN, video.ORANGE)[index]
        radius = 19
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=accent)
    for x, y, label in [
        (110, 1060, "KICKOFF"),
        (362, 1005, "SETUP"),
        (607, 1077, "HANDOFF"),
        (854, 1018, "GO-LIVE"),
    ]:
        draw.text((x, y), label, font=video.font(14, True), fill=video.MUTED)

    draw.rounded_rectangle((64, 1172, 1016, 1266), radius=30, fill=video.CYAN)
    draw.text((110, 1202), "Make the next step clear.", font=video.font(32, True), fill=video.INK)
    draw.text((68, 1307), "relayautomation.tech", font=video.font(20, True), fill=video.WHITE)
    image.convert("RGB").save(POST, quality=95)
    CAPTION.write_text(CAPTION_TEXT + "\n", encoding="utf-8")
    print(f"Created {POST}")
    print(f"Created {CAPTION}")


def create_video():
    video.OUTPUT = VIDEO
    video.VOICEOVER = VOICEOVER
    video.VOICE_SCRIPT = VOICE_SCRIPT
    video.DURATION = 30
    video.SCENES = CAMPAIGN
    video.main()


if __name__ == "__main__":
    create_social_post()
    create_video()
