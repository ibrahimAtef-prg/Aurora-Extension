#!/usr/bin/env python3
"""
Aurora — Statistical Summary Report Builder
Generates a professional DOCX with embedded charts from pipeline JSON data.

Usage:
    python aurora_stat_docx.py <data_json_path> <output_docx_path>

JSON schema:
{
  "scope": "comparison|baseline|synthetic",
  "baseline": { "row_count": N, "columns": { col: {mean,std,min,max,median} } },
  "synthetic": { "row_count": N, "stats": { col: {mean,std,min,max,median} } },
  "leakage": { "privacy_score":0.79, "risk_level":"low", "mi_auc":0.725,
               "drift_level":"low", "drift_scores":{}, "pii_columns":[],
               "detected_threats":[] },
  "dataset_name": "ds_salaries.csv",
  "generated_at": "2026-06-07 21:12 UTC"
}
"""
import sys
import json
import io
import math
from datetime import datetime, timezone

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

from docx import Document
from docx.shared import Inches, Pt, RGBColor, Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# ── Colour palette ────────────────────────────────────────────────────────────
C_PURPLE   = RGBColor(0x6B, 0x24, 0xE8)   # Aurora brand
C_TEAL     = RGBColor(0x00, 0xB4, 0xA0)   # Synthetic accent
C_DARK     = RGBColor(0x1E, 0x1E, 0x2E)   # Near-black header
C_MID      = RGBColor(0x40, 0x40, 0x5A)   # Sub-header
C_LIGHT    = RGBColor(0xF4, 0xF0, 0xFF)   # Purple tint fill
C_WHITE    = RGBColor(0xFF, 0xFF, 0xFF)
C_GREEN    = RGBColor(0x1A, 0x7A, 0x4A)
C_ORANGE   = RGBColor(0xD4, 0x6A, 0x00)
C_RED      = RGBColor(0xC0, 0x00, 0x00)
C_BORDER   = "CCCCCC"
C_HDR_FILL = "000000"
C_ALT_FILL = "F0F0F0"
C_SYN_HDR  = "000000"

# ── Matplotlib style ──────────────────────────────────────────────────────────
MPLOT_STYLE = {
    'figure.facecolor': '#FFFFFF',
    'axes.facecolor':   '#FAFAFA',
    'axes.edgecolor':   '#CCCCCC',
    'axes.grid':        True,
    'grid.color':       '#E8E8E8',
    'grid.linewidth':   0.8,
    'font.family':      'DejaVu Sans',
    'font.size':        9,
    'axes.titlesize':   11,
    'axes.titleweight': 'bold',
    'axes.labelsize':   9,
    'xtick.labelsize':  8,
    'ytick.labelsize':  8,
    'legend.fontsize':  8,
}

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _hex(rgb: RGBColor) -> str:
    return f"{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"

def _set_cell_fill(cell, hex_colour: str):
    tc   = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd  = OxmlElement('w:shd')
    shd.set(qn('w:val'),   'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'),  hex_colour)
    tcPr.append(shd)

def _cell_text(cell, text: str, bold=False, size=9,
               color: RGBColor = None, align=WD_ALIGN_PARAGRAPH.LEFT):
    p = cell.paragraphs[0]
    p.alignment = align
    run = p.add_run(str(text))
    run.bold = bold
    run.font.size = Pt(size)
    if color:
        run.font.color.rgb = color

def _add_border(cell):
    tc   = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcBorders = OxmlElement('w:tcBorders')
    for side in ('top', 'left', 'bottom', 'right'):
        el = OxmlElement(f'w:{side}')
        el.set(qn('w:val'),   'single')
        el.set(qn('w:sz'),    '4')
        el.set(qn('w:space'), '0')
        el.set(qn('w:color'), C_BORDER)
        tcBorders.append(el)
    tcPr.append(tcBorders)

def _para(doc, text, style='Normal', bold=False, size=None,
          color: RGBColor = None, space_before=0, space_after=6,
          align=WD_ALIGN_PARAGRAPH.LEFT) -> None:
    p = doc.add_paragraph(style=style)
    p.alignment = align
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.space_after  = Pt(space_after)
    if text:
        r = p.add_run(text)
        r.bold = bold
        if size:  r.font.size = Pt(size)
        if color: r.font.color.rgb = color

def _png_from_fig(fig) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=140, bbox_inches='tight')
    plt.close(fig)
    buf.seek(0)
    return buf.read()

def _add_image_para(doc, png_bytes: bytes, width_in=6.0) -> None:
    p   = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    run.add_picture(io.BytesIO(png_bytes), width=Inches(width_in))

def _fmt(v, decimals=4):
    if v is None: return '—'
    if isinstance(v, float): return f'{v:,.{decimals}f}'
    return str(v)

def _delta_str(b_mean, s_mean):
    if b_mean is None or s_mean is None or b_mean == 0:
        return '—', None
    d = ((s_mean - b_mean) / abs(b_mean)) * 100
    return f'{d:+.1f}%', d

# ─────────────────────────────────────────────────────────────────────────────
# Chart generators
# ─────────────────────────────────────────────────────────────────────────────

def chart_mean_comparison(cols, b_means, s_means, b_stds, s_stds) -> bytes:
    plt.rcParams.update(MPLOT_STYLE)
    n   = len(cols)
    x   = np.arange(n)
    w   = 0.35
    fig, ax = plt.subplots(figsize=(max(6, n * 0.9), 4))

    bars_b = ax.bar(x - w/2, b_means, w, label='Original (Baseline)',
                    color='#6B24E8', alpha=0.85, zorder=3)
    bars_s = ax.bar(x + w/2, s_means, w, label='Synthetic',
                    color='#00B4A0', alpha=0.85, zorder=3)

    # Error bars (std)
    if b_stds:
        ax.errorbar(x - w/2, b_means, yerr=b_stds, fmt='none',
                    color='#3A0090', capsize=4, linewidth=1.2, zorder=4)
    if s_stds:
        ax.errorbar(x + w/2, s_means, yerr=s_stds, fmt='none',
                    color='#006B60', capsize=4, linewidth=1.2, zorder=4)

    # Delta annotations
    for i, (bm, sm) in enumerate(zip(b_means, s_means)):
        if bm and bm != 0:
            d = ((sm - bm) / abs(bm)) * 100
            colour = '#C00000' if abs(d) > 10 else '#1A7A4A'
            ax.text(i, max(bm, sm) * 1.02, f'{d:+.1f}%',
                    ha='center', va='bottom', fontsize=7, color=colour, fontweight='bold')

    ax.set_xticks(x)
    ax.set_xticklabels(cols, rotation=20, ha='right')
    ax.set_ylabel('Mean value')
    ax.set_title('Column Mean Comparison — Original vs Synthetic (error bars = ±1 std)')
    ax.legend(loc='upper right')
    fig.tight_layout()
    return _png_from_fig(fig)


def chart_drift_scores(drift_scores: dict) -> bytes:
    if not drift_scores:
        return None
    plt.rcParams.update(MPLOT_STYLE)
    items = sorted(drift_scores.items(), key=lambda x: x[1], reverse=True)
    cols  = [i[0] for i in items]
    vals  = [i[1] for i in items]
    colours = ['#C00000' if v >= 0.15 else '#D46A00' if v >= 0.05 else '#1A7A4A'
               for v in vals]
    fig, ax = plt.subplots(figsize=(max(5, len(cols) * 0.75), 3.5))
    bars = ax.barh(cols, vals, color=colours, alpha=0.85, zorder=3)
    ax.axvline(0.05, color='#D46A00', linewidth=1.2, linestyle='--', label='Moderate (0.05)')
    ax.axvline(0.15, color='#C00000', linewidth=1.2, linestyle='--', label='High (0.15)')
    ax.set_xlabel('Drift score')
    ax.set_title('Column Drift Scores')
    ax.legend(loc='lower right', fontsize=7)
    ax.invert_yaxis()
    for bar, v in zip(bars, vals):
        ax.text(v + 0.002, bar.get_y() + bar.get_height()/2,
                f'{v:.4f}', va='center', fontsize=7)
    fig.tight_layout()
    return _png_from_fig(fig)


def chart_privacy_gauge(privacy_score: float, mi_auc: float) -> bytes:
    plt.rcParams.update(MPLOT_STYLE)
    fig, axes = plt.subplots(1, 2, figsize=(6, 3))
    for ax, val, title, low, high in [
        (axes[0], privacy_score * 100 if privacy_score else 0,
         f'Privacy Score\n{privacy_score*100:.0f}%' if privacy_score else 'Privacy Score\n—',
         0, 100),
        (axes[1], (1 - mi_auc) * 100 if mi_auc else 0,
         f'MI-AUC Safety\n{(1-mi_auc)*100:.0f}%' if mi_auc else 'MI-AUC Safety\n—',
         0, 100),
    ]:
        angle_start, angle_end = 180, 0
        theta_fill = np.linspace(np.pi, np.pi - (val / 100) * np.pi, 200)
        theta_bg   = np.linspace(np.pi, 0, 200)
        ax.fill_between(np.cos(theta_bg),   np.zeros(200), np.sin(theta_bg), color='#F0F0F0')
        colour = '#1A7A4A' if val >= 80 else '#D46A00' if val >= 60 else '#C00000'
        ax.fill_between(np.cos(theta_fill), np.zeros(200), np.sin(theta_fill), color=colour, alpha=0.85)
        ax.set_aspect('equal')
        ax.set_xlim(-1.1, 1.1)
        ax.set_ylim(-0.15, 1.1)
        ax.axis('off')
        ax.set_title(title, fontsize=9, fontweight='bold', color=colour)
    fig.tight_layout()
    return _png_from_fig(fig)


# ─────────────────────────────────────────────────────────────────────────────
# DOCX builder
# ─────────────────────────────────────────────────────────────────────────────

def build_docx(data: dict, out_path: str) -> None:
    scope        = data.get('scope', 'comparison')
    b_data       = data.get('baseline', {})
    s_data       = data.get('synthetic', {})
    leakage      = data.get('leakage', {})
    dataset_name = data.get('dataset_name', 'dataset')
    generated_at = data.get('generated_at', datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC'))

    b_cols: dict = b_data.get('columns', {})
    s_stats: dict = s_data.get('stats', {})
    b_rows   = b_data.get('row_count')
    s_rows   = s_data.get('row_count')
    num_cols = list(b_cols.keys())

    doc = Document()

    # ── Page setup ─────────────────────────────────────────────────────────
    for section in doc.sections:
        section.page_width   = Emu(12240 * 914)    # 8.5 in
        section.page_height  = Emu(15840 * 914)    # 11 in
        section.left_margin  = Inches(1)
        section.right_margin = Inches(1)
        section.top_margin   = Inches(1)
        section.bottom_margin = Inches(1)

    # ── Styles ─────────────────────────────────────────────────────────────
    doc.styles['Normal'].font.name = 'Calibri'
    doc.styles['Normal'].font.size = Pt(10)

    # ── Cover block ────────────────────────────────────────────────────────
    title_map = {
        'comparison': 'Statistical Summary Report',
        'baseline':   'Original Data — Statistical Summary',
        'synthetic':  'Synthetic Data — Statistical Summary',
    }
    sub_map = {
        'comparison': 'Original vs Synthetic Comparison',
        'baseline':   'Baseline Dataset Analysis',
        'synthetic':  'Generated Dataset Analysis',
    }

    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p_title.add_run(title_map[scope])
    r.bold = True; r.font.size = Pt(22); r.font.color.rgb = C_PURPLE

    _para(doc, sub_map[scope], bold=False, size=13,
          color=C_MID, align=WD_ALIGN_PARAGRAPH.CENTER, space_before=4, space_after=4)
    _para(doc, f'Dataset: {dataset_name}', size=10,
          color=C_MID, align=WD_ALIGN_PARAGRAPH.CENTER)
    _para(doc, f'Generated: {generated_at}', size=9,
          color=RGBColor(0x80, 0x80, 0x90), align=WD_ALIGN_PARAGRAPH.CENTER, space_after=12)

    # Divider
    p_div = doc.add_paragraph()
    p_div.paragraph_format.space_after = Pt(10)
    p_div._p.get_or_add_pPr().append(
        OxmlElement('w:pBdr')
    )
    pBdr = p_div._p.pPr.find(qn('w:pBdr'))
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'),   'single')
    bottom.set(qn('w:sz'),    '6')
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), _hex(C_PURPLE))
    pBdr.append(bottom)

    # ── 1. Dataset Overview ────────────────────────────────────────────────
    _para(doc, '1. Dataset Overview', bold=True, size=13, color=C_DARK, space_before=6)

    tbl = doc.add_table(rows=1, cols=2)
    tbl.style = 'Table Grid'
    tbl.alignment = WD_TABLE_ALIGNMENT.LEFT
    hdr = tbl.rows[0].cells
    _set_cell_fill(hdr[0], C_HDR_FILL)
    _cell_text(hdr[0], 'Property', bold=True, color=C_WHITE, size=9)
    _set_cell_fill(hdr[1], C_HDR_FILL)
    _cell_text(hdr[1], 'Value', bold=True, color=C_WHITE, size=9)

    rows_data = []
    if scope != 'synthetic':
        rows_data.append(('Original (baseline) rows', f'{b_rows:,}' if b_rows else '—'))
    if scope != 'baseline':
        rows_data.append(('Synthetic (generated) rows', f'{s_rows:,}' if s_rows else '—'))
    rows_data += [
        ('Numeric columns',   str(len(num_cols))),
        ('Privacy score',     f"{leakage.get('privacy_score', 0)*100:.0f}%" if leakage.get('privacy_score') else '—'),
        ('Risk level',        leakage.get('risk_level', '—')),
        ('MI-AUC',            f"{leakage.get('mi_auc', leakage.get('membership_inference_auc', '—')):.4f}"
                              if isinstance(leakage.get('mi_auc', leakage.get('membership_inference_auc')), float)
                              else '—'),
        ('Drift level',       leakage.get('drift_level', '—')),
    ]
    if leakage.get('pii_columns'):
        rows_data.append(('PII columns', ', '.join(leakage['pii_columns'])))

    for i, (k, v) in enumerate(rows_data):
        row = tbl.add_row().cells
        fill = C_ALT_FILL if i % 2 == 1 else 'FFFFFF'
        _set_cell_fill(row[0], fill); _set_cell_fill(row[1], fill)
        _add_border(row[0]); _add_border(row[1])
        _cell_text(row[0], k, bold=True, size=9)
        _cell_text(row[1], v, size=9)

    doc.add_paragraph()

    # ── 2. Column Statistics ───────────────────────────────────────────────
    if scope == 'comparison' and num_cols:
        _para(doc, '2. Column Comparison — Original vs Synthetic', bold=True, size=13,
              color=C_DARK, space_before=6)

        headers = ['Column', 'Orig. Mean', 'Synth. Mean', 'Δ%',
                   'Orig. Std', 'Synth. Std', 'Orig. Min', 'Orig. Max']
        col_w = [1.2, 0.95, 0.95, 0.65, 0.85, 0.85, 0.8, 0.8]
        tbl2 = doc.add_table(rows=1, cols=len(headers))
        tbl2.style = 'Table Grid'
        tbl2.alignment = WD_TABLE_ALIGNMENT.LEFT
        for j, (h, w) in enumerate(zip(headers, col_w)):
            cell = tbl2.rows[0].cells[j]
            cell.width = Inches(w)
            fill = C_HDR_FILL if j < 3 else C_SYN_HDR if j < 6 else '555577'
            _set_cell_fill(cell, fill)
            _cell_text(cell, h, bold=True, color=C_WHITE, size=8,
                       align=WD_ALIGN_PARAGRAPH.CENTER)

        for i, col in enumerate(num_cols):
            b = b_cols.get(col, {})
            s = s_stats.get(col, {})
            bm = b.get('mean'); sm = s.get('mean')
            delta_str, delta_val = _delta_str(bm, sm)
            row = tbl2.add_row().cells
            fill_base = C_ALT_FILL if i % 2 == 1 else 'FFFFFF'

            # Colour Δ cell by significance
            if delta_val is not None:
                delta_fill = 'FFE0E0' if abs(delta_val) > 10 else 'E8FFF0' if abs(delta_val) < 2 else 'FFF8E0'
                delta_color = C_RED if abs(delta_val) > 10 else C_GREEN if abs(delta_val) < 2 else C_ORANGE
            else:
                delta_fill, delta_color = 'F8F8F8', C_MID

            vals_row = [col,
                        _fmt(bm), _fmt(sm), delta_str,
                        _fmt(b.get('std')), _fmt(s.get('std')),
                        _fmt(b.get('min'), 2), _fmt(b.get('max'), 2)]

            for j, v in enumerate(vals_row):
                cell = row[j]
                cell.width = Inches(col_w[j])
                if j == 3:
                    _set_cell_fill(cell, delta_fill)
                    _add_border(cell)
                    _cell_text(cell, v, bold=(delta_val is not None and abs(delta_val) > 10),
                               color=delta_color, size=8, align=WD_ALIGN_PARAGRAPH.CENTER)
                else:
                    _set_cell_fill(cell, fill_base)
                    _add_border(cell)
                    _cell_text(cell, v, size=8,
                               bold=(j == 0),
                               align=WD_ALIGN_PARAGRAPH.LEFT if j == 0 else WD_ALIGN_PARAGRAPH.RIGHT)

        # Legend
        _para(doc, 'Δ < 2%: High fidelity   |   2-10%: Monitor   |   > 10%: Review required',
              size=8, color=C_MID, space_before=4, space_after=8)

    elif scope in ('baseline', 'synthetic') and num_cols:
        label = 'Original' if scope == 'baseline' else 'Synthetic'
        _para(doc, f'2. Column Statistics — {label} Data', bold=True, size=13,
              color=C_DARK, space_before=6)
        hdrs2 = ['Column', 'Mean', 'Std', 'Min', 'Max', 'Median']
        cw2   = [1.5, 1.2, 1.2, 1.0, 1.0, 1.0]
        tbl3  = doc.add_table(rows=1, cols=len(hdrs2))
        tbl3.style = 'Table Grid'
        for j, (h, w) in enumerate(zip(hdrs2, cw2)):
            cell = tbl3.rows[0].cells[j]
            cell.width = Inches(w)
            _set_cell_fill(cell, C_HDR_FILL if scope == 'baseline' else C_SYN_HDR)
            _cell_text(cell, h, bold=True, color=C_WHITE, size=9,
                       align=WD_ALIGN_PARAGRAPH.CENTER)
        src = b_cols if scope == 'baseline' else s_stats
        for i, col in enumerate(num_cols):
            d = src.get(col, {})
            row = tbl3.add_row().cells
            fill = C_ALT_FILL if i % 2 == 1 else 'FFFFFF'
            for j, v in enumerate([col, _fmt(d.get('mean')), _fmt(d.get('std')),
                                    _fmt(d.get('min'), 2), _fmt(d.get('max'), 2),
                                    _fmt(d.get('median'), 2)]):
                cell = row[j]
                cell.width = Inches(cw2[j])
                _set_cell_fill(cell, fill); _add_border(cell)
                _cell_text(cell, v, size=9, bold=(j == 0),
                           align=WD_ALIGN_PARAGRAPH.LEFT if j == 0 else WD_ALIGN_PARAGRAPH.RIGHT)

    doc.add_paragraph()

    # ── 3. Chart: Mean Comparison (comparison scope only) ──────────────────
    if scope == 'comparison' and num_cols:
        _para(doc, '3. Visual — Column Mean Comparison', bold=True, size=13,
              color=C_DARK, space_before=6, space_after=4)
        try:
            b_means = [b_cols.get(c, {}).get('mean', 0) or 0 for c in num_cols]
            s_means = [s_stats.get(c, {}).get('mean', 0) or 0 for c in num_cols]
            b_stds  = [b_cols.get(c, {}).get('std', 0) or 0  for c in num_cols]
            s_stds  = [s_stats.get(c, {}).get('std', 0) or 0  for c in num_cols]
            png = chart_mean_comparison(num_cols, b_means, s_means, b_stds, s_stds)
            _add_image_para(doc, png, width_in=6.5)
        except Exception as _ce:
            _para(doc, f'[Chart unavailable: {_ce}]', size=8, color=C_MID)

    # ── 4. Chart: Drift Scores ─────────────────────────────────────────────
    drift_scores = leakage.get('drift_scores')
    if drift_scores:
        sec_num = '4' if scope == 'comparison' else '3'
        _para(doc, f'{sec_num}. Visual — Column Drift Scores', bold=True, size=13,
              color=C_DARK, space_before=8, space_after=4)
        try:
            png_drift = chart_drift_scores(drift_scores)
            if png_drift:
                _add_image_para(doc, png_drift, width_in=5.5)
        except Exception as _ce:
            _para(doc, f'[Chart unavailable: {_ce}]', size=8, color=C_MID)

    # ── 5. Chart: Privacy Gauge ────────────────────────────────────────────
    ps   = leakage.get('privacy_score')
    mauc = leakage.get('mi_auc', leakage.get('membership_inference_auc'))
    _chart_sec = 3  # dynamic section counter for non-comparison scopes
    if scope == 'comparison':
        _chart_sec = 5  # after sections 3 (mean) and 4 (drift)
    elif drift_scores:
        _chart_sec = 4  # after section 3 (drift)
    if ps or mauc:
        _para(doc, f'{_chart_sec}. Visual — Privacy & Security Indicators',
              bold=True, size=13, color=C_DARK, space_before=8, space_after=4)
        try:
            png_gauge = chart_privacy_gauge(ps or 0, mauc or 0)
            _add_image_para(doc, png_gauge, width_in=5.0)
        except Exception as _ce:
            _para(doc, f'[Chart unavailable: {_ce}]', size=8, color=C_MID)
        _para(doc, 'Left: Privacy score (higher = better).  '
                   'Right: Membership-inference safety = 1 − MI-AUC (higher = harder to attack).',
              size=8, color=C_MID, space_after=8)
        _chart_sec += 1  # advance for the risk table

    # ── Privacy & Risk Table (dynamic section number) ─────────────────────
    last_sec = _chart_sec
    _para(doc, f'{last_sec}. Privacy & Risk Assessment', bold=True, size=13,
          color=C_DARK, space_before=6)
    threats = leakage.get('detected_threats', [])
    risk_rows = [
        ('Privacy score',  f"{ps*100:.0f}%" if ps else '—',
         'Good' if ps and ps >= 0.8 else 'Moderate' if ps and ps >= 0.6 else 'Low'),
        ('Risk level',     leakage.get('risk_level', '—'),
         'Low' if leakage.get('risk_level') == 'low' else 'Medium' if leakage.get('risk_level') == 'medium' else 'High'),
        ('MI-AUC',         f"{mauc:.4f}" if isinstance(mauc, float) else '—',
         'Low risk' if isinstance(mauc,float) and mauc < 0.6
         else 'Moderate' if isinstance(mauc,float) and mauc < 0.75 else 'High risk'
         if isinstance(mauc,float) else '—'),
        ('Drift level',    leakage.get('drift_level', '—'),
         'Acceptable' if leakage.get('drift_level') == 'low'
         else 'Review' if leakage.get('drift_level') == 'medium' else 'High'),
        ('PII columns',    ', '.join(leakage.get('pii_columns', [])) or 'None detected',
         'Review before sharing' if leakage.get('pii_columns') else 'None detected'),
    ]
    if threats:
        risk_rows.append(('Threats detected', str(len(threats)),
                          'Review' if len(threats) <= 2 else 'Critical'))

    tbl4 = doc.add_table(rows=1, cols=3)
    tbl4.style = 'Table Grid'
    for j, h in enumerate(['Metric', 'Value', 'Assessment']):
        cell = tbl4.rows[0].cells[j]
        _set_cell_fill(cell, C_HDR_FILL)
        _cell_text(cell, h, bold=True, color=C_WHITE, size=9)
    for i, (m, v, s) in enumerate(risk_rows):
        row = tbl4.add_row().cells
        fill = C_ALT_FILL if i % 2 == 1 else 'FFFFFF'
        for j, txt in enumerate([m, v, s]):
            _set_cell_fill(row[j], fill); _add_border(row[j])
            _cell_text(row[j], txt, size=9, bold=(j == 0))

    # Threats details
    if threats:
        doc.add_paragraph()
        _para(doc, 'Detected Threats:', bold=True, size=10, color=C_DARK)
        for t in threats:
            sev  = t.get('severity', 'unknown')
            name = t.get('type', t.get('name', str(t)))
            desc = t.get('description', '')
            p    = doc.add_paragraph(style='List Bullet')
            r1   = p.add_run(f'[{sev.upper()}] {name}')
            r1.bold = True
            r1.font.color.rgb = C_DARK
            if desc:
                r2 = p.add_run(f' — {desc}')
                r2.font.size = Pt(9)

    # ── Footer note ────────────────────────────────────────────────────────
    doc.add_paragraph()
    _para(doc, f'Aurora Privacy Platform · {generated_at}',
          size=8, color=RGBColor(0xA0, 0xA0, 0xB0),
          align=WD_ALIGN_PARAGRAPH.CENTER, space_before=12)

    doc.save(out_path)
    print(f'[aurora] DOCX saved → {out_path}')


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: aurora_stat_docx.py <data.json> <output.docx>', file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data = json.load(f)
    build_docx(data, sys.argv[2])
