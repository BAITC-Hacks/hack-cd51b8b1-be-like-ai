"""Inspect both downloaded formats, not just their filename or magic bytes."""

import argparse
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree

from pypdf import PdfReader


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("docx", type=Path)
    parser.add_argument("--contains", action="append", required=True)
    args = parser.parse_args()
    assert args.pdf.read_bytes().startswith(b"%PDF-"), "Invalid PDF signature"
    pdf_text = " ".join(page.extract_text() or "" for page in PdfReader(args.pdf).pages)
    with ZipFile(args.docx) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
        docx_text = " ".join(root.itertext())
    for label, text in (("PDF", pdf_text), ("DOCX", docx_text)):
        normalized = " ".join(text.split())
        for expected in args.contains:
            assert expected in normalized, f"{label} missing expected text: {expected!r}"
    print("PDF and DOCX contain the saved task, assignee, status, deadline and source text.")


if __name__ == "__main__":
    main()
