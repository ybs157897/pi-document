"""Regenerate the public synthetic Chinese CID-font parser fixture with reportlab."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

target = Path(__file__).parent / "pdf" / "chinese.pdf"
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
document = canvas.Canvas(str(target), invariant=1)
document.setFont("STSong-Light", 14)
document.drawString(72, 760, "中文向量检索与持久任务恢复")
document.drawString(72, 730, "验收编号：PDF-CN-2026-01。")
document.drawString(72, 700, "重启后原始文档与来源页码必须保持一致。")
document.save()
