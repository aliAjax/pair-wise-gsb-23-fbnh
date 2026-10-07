import { useMemo, useState } from "react";
import "./styles.css";
import { ROLE_LABEL, type Role, type SampleBatch } from "./domain/types";
import { useStore } from "./state/store";
import SubmitForm from "./ui/SubmitForm";
import Dashboard from "./ui/Dashboard";
import Dispositions from "./ui/Dispositions";
import Conflicts from "./ui/Conflicts";
import Policies from "./ui/Policies";
import AuditLog from "./ui/AuditLog";
import ResampleModal from "./ui/ResampleModal";

type Tab = "dashboard" | "submit" | "dispositions" | "conflicts" | "policies" | "audit";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "dashboard", label: "判定看板", hint: "统一判定结果" },
  { key: "submit", label: "采样录入", hint: "巡检员" },
  { key: "dispositions", label: "异常处置", hint: "班组长签认" },
  { key: "conflicts", label: "冲突与上传", hint: "并发 / 断点续传" },
  { key: "policies", label: "校准与阈值", hint: "厂务工程师" },
  { key: "audit", label: "审计日志", hint: "只读" },
];

const ROLES: Role[] = ["inspector", "engineer", "leader", "auditor"];

const ACTOR_BY_ROLE: Record<Role, string> = {
  inspector: "巡检员·王巡",
  engineer: "厂务工程师·冯工",
  leader: "班组长·周班",
  auditor: "审计员·钱审",
};

const PERMISSION_TEXT: Record<Role, string> = {
  inspector: "可提交采样、补录、补采，处理冲突草稿；不可签认；审计只读",
  engineer: "可发布仪器校准与阈值版本（驱动未签认异常重算）；可浏览全部判定",
  leader: "可签认异常（冻结原值与依据）；其余操作只读",
  auditor: "全系统只读：看板、处置、依据、审计日志",
};

function App() {
  const store = useStore();
  const [role, setRole] = useState<Role>("inspector");
  const [tab, setTab] = useState<Tab>("dashboard");
  const [resampleTarget, setResampleTarget] = useState<SampleBatch | null>(null);
  const actor = ACTOR_BY_ROLE[role];

  const outboxCount = store.outboxBatches.length;
  const draftCount = store.draftBatches.length;

  const tabBadge = useMemo(
    () =>
      ({
        conflicts: outboxCount + draftCount,
      } as Partial<Record<Tab, number>>),
    [outboxCount, draftCount]
  );

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · 半导体洁净室巡检 · 统一判定</p>
          <h1>粒子采样 · 校准 · 阈值 · 异常处置一体判定</h1>
          <p className="subtitle">
            采样按体积换算每立方米计数并适用判定当时有效的阈值版本；低于 2 L 待补采不判异；
            依据更新只重算未签认记录，已签认冻结原值原依据；首份有效入库、后到留草稿冲突；
            断点重试幂等。看板、处置、导出显示同一判定。
          </p>
        </div>
        <div className="stack-card role-card">
          <span>当前角色（点击切换体验权限）</span>
          <div className="role-switch">
            {ROLES.map((r) => (
              <button
                key={r}
                className={r === role ? "role-btn on" : "role-btn"}
                onClick={() => setRole(r)}
              >
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
          <strong>{actor}</strong>
          <p className="cell-sub">{PERMISSION_TEXT[role]}</p>
          <button className="ghost reset-btn" onClick={() => store.actions.resetDemo(actor, role)}>
            重置演示数据
          </button>
        </div>
      </section>

      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "tab on" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {tabBadge[t.key] ? <span className="tab-badge">{tabBadge[t.key]}</span> : null}
            <i>{t.hint}</i>
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {tab === "dashboard" && (
          <Dashboard
            store={store}
            role={role}
            actor={actor}
            onResample={(b) => setResampleTarget(b)}
          />
        )}
        {tab === "submit" && <SubmitForm store={store} role={role} actor={actor} />}
        {tab === "dispositions" && <Dispositions store={store} role={role} actor={actor} />}
        {tab === "conflicts" && <Conflicts store={store} role={role} actor={actor} />}
        {tab === "policies" && <Policies store={store} role={role} actor={actor} />}
        {tab === "audit" && <AuditLog store={store} />}
      </div>

      <section className="panel rules-panel">
        <div className="section-heading">
          <div>
            <p>同一套判定规则</p>
            <h2>规则速览</h2>
          </div>
        </div>
        <ol className="rules">
          <li>
            <strong>体积换算：</strong>采样体积 = 仪器流量(L/min) × 时长(s) ÷ 60；
            每立方米计数 = 原始计数 × 校准系数 ÷ 体积(L) × 1000。阈值取
            <strong>判定当时有效</strong>的版本；签认即把当时版本冻结。
          </li>
          <li>
            <strong>低体积：</strong>体积低于 2 L 的批次标记「待补采」，不参与异常判定；
            巡检员补采后原批次标记已补采，以补采批次为准。
          </li>
          <li>
            <strong>依据更新：</strong>校准系数或阈值版本更新后，
            <strong>未签认</strong>异常按新依据重算（阈值采用当前有效版本）；
            <strong>已签认</strong>异常保留签认时的原值、系数、阈值版本，只旁示现行重算值。
          </li>
          <li>
            <strong>并发提交：</strong>同一次采样（同房间+同采样时刻）现场与中心同时提交时，
            首份有效记录入库，后到者留草稿并看到冲突，可丢弃或改时刻作为新采样。
          </li>
          <li>
            <strong>断点续传：</strong>上传失败的批次留在队列，恢复网络后从断点重试；
            重放幂等——不新增处置单、不新增审计，已入库批次绝不重复处理。
          </li>
          <li>
            <strong>权限：</strong>巡检员可补录/补采，班组长可签认，厂务工程师管理校准与阈值，
            审计员只读。看板、异常处置、CSV 导出均来自同一个 <code>evaluateBatch</code> 判定。
          </li>
        </ol>
      </section>

      {resampleTarget ? (
        <ResampleModal
          store={store}
          original={resampleTarget}
          role={role}
          actor={actor}
          onClose={() => setResampleTarget(null)}
        />
      ) : null}
    </main>
  );
}

export default App;
