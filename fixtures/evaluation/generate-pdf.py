"""Create deterministic text PDFs for the synthetic retrieval evaluation set."""

import json
import sys
from pathlib import Path, PurePosixPath

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas


def wrap_line(text: str, font_name: str, font_size: float, max_width: float) -> list[str]:
    if pdfmetrics.stringWidth(text, font_name, font_size) <= max_width:
        return [text]
    lines: list[str] = []
    current = ""
    for token in text.split(" "):
        candidate = token if not current else f"{current} {token}"
        if pdfmetrics.stringWidth(candidate, font_name, font_size) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
                current = ""
            if pdfmetrics.stringWidth(token, font_name, font_size) <= max_width:
                current = token
            else:
                for character in token:
                    candidate = current + character
                    if pdfmetrics.stringWidth(candidate, font_name, font_size) > max_width and current:
                        lines.append(current)
                        current = character
                    else:
                        current = candidate
    if current:
        lines.append(current)
    return lines


def main() -> None:
    input_path = Path(sys.argv[1]).resolve()
    output_root = Path(sys.argv[2]).resolve()
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    font_name = "STSong-Light"
    font_size = 10
    max_width = 468

    for item in payload["documents"]:
        relative_path = PurePosixPath(item["path"])
        if relative_path.is_absolute() or ".." in relative_path.parts or relative_path.suffix.lower() != ".pdf":
            raise ValueError("PDF fixture path is invalid")
        target = output_root.joinpath(*relative_path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        document = canvas.Canvas(str(target), invariant=1, pageCompression=1)
        document.setTitle(item["title"])
        document.setAuthor("Pi Document synthetic evaluation fixture")
        document.setFont(font_name, font_size)
        y = 748
        for paragraph in item["paragraphs"]:
            for line in wrap_line(paragraph, font_name, font_size, max_width):
                if y < 60:
                    document.showPage()
                    document.setFont(font_name, font_size)
                    y = 748
                document.drawString(72, y, line)
                y -= 16
            y -= 6
        document.save()


if __name__ == "__main__":
    main()
