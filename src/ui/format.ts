// 展示与导出共用的格式化工具；判定数据一律来自 evaluateBatch

import type { BatchEvaluation } from "../domain/evaluation";
import { CHANNEL_LABEL, VERDICT_LABEL } from "../domain/types";

export function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function toDatetimeLocalValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export function verdictClass(verdict: BatchEvaluation["verdict"]): string {
  if (verdict === "abnormal") return "badge-danger";
  if (verdict === "resample") return "badge-warn";
  return "badge-ok";
}

export function verdictText(verdict: BatchEvaluation["verdict"]): string {
  return VERDICT_LABEL[verdict];
}

export function fmtNum(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("zh-CN");
}

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出内容与看板/处置页同一判定来源 */
export function exportEvaluationsCsv(
  rows: BatchEvaluation[],
  draftInfo: { id: string; conflictWithId?: string }[],
  filename = `洁净室采样判定_${new Date().toISOString().slice(0, 10)}.csv`
): void {
  const header = [
    "批次号",
    "房间",
    "区域",
    "等级",
    "采样时刻",
    "提交渠道",
    "提交人",
    "采样体积(L)",
    "校准系数",
    "每立方米计数(粒/m³)",
    "阈值上限(粒/m³)",
    "适用阈值版本",
    "判定",
    "签认状态",
    "处置备注",
    "判定依据",
  ];

  const lines = [header.map(csvCell).join(",")];

  for (const ev of rows) {
    const b = ev.batch;
    lines.push(
      [
        b.id,
        b.room,
        b.area,
        b.grade,
        fmtDateTime(b.sampledAt),
        CHANNEL_LABEL[b.channel],
        b.submittedBy,
        ev.volumeL.toFixed(2),
        ev.factor ?? "—",
        ev.perM3 ?? "—",
        ev.limit ?? "—",
        ev.active?.policyVersion ?? "—",
        VERDICT_LABEL[ev.verdict],
        ev.signed ? `已签认(${ev.disposition?.signedBy ?? ""})` : "未签认",
        ev.disposition?.remark ?? "",
        ev.basis,
      ]
        .map(csvCell)
        .join(",")
    );
  }

  for (const d of draftInfo) {
    lines.push(
      [
        d.id,
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        "草稿(冲突)",
        "—",
        "—",
        `与首份有效记录 ${d.conflictWithId ?? ""} 冲突，未入库不参与判定`,
      ]
        .map(csvCell)
        .join(",")
    );
  }

  // 加 BOM，Excel 打开中文不乱码
  const blob = new Blob(["﻿" + lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
