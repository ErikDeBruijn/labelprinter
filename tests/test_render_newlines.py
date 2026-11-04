from app import render


def _design(text, wrap):
    return {"label": {"width_mm": 62, "height_mm": 30},
            "elements": [{"type": "text", "x_mm": 2, "y_mm": 2, "w_mm": 40, "h_mm": 20,
                          "text": text, "size_pt": 14, "wrap": wrap}]}


def _inked_rows(img):
    return [y for y in range(img.height) if min(img.crop((0, y, img.width, y + 1)).tobytes()) < 128]


def _line_count(img):
    rows = _inked_rows(img)
    return 1 + sum(1 for a, b in zip(rows, rows[1:]) if b - a > 5)


def test_placeholder_substitution_keeps_newlines():
    assert render._sub("Betaal-\n{{x}}  link", {"x": ""}) == "Betaal-\nlink"


def test_newline_starts_a_line_without_wrap():
    assert _line_count(render.render_design(_design("Betaal-\nlink", wrap=False), {})) == 2
    assert _line_count(render.render_design(_design("Betaal- link", wrap=False), {})) == 1


def test_newline_starts_a_line_with_wrap():
    assert _line_count(render.render_design(_design("Betaal-\nlink", wrap=True), {})) == 2
