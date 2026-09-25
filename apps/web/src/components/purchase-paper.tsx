import type { ReactNode } from "react";
import type { PurchasePrint } from "@farooq/shared";
import { fmtDate } from "../lib/format";

/**
 * The printed purchase, drawn from the ONE `PurchasePrint` model the server builds, in the legacy standard document layout (`Paper.html`,
 * the same sheet as the standard invoice — `invoice-paper.css`). Every figure and label comes from the model; paper colours are fixed.
 */

const isUrdu = (s: string | null | undefined): boolean => /[؀-ۿ]/.test(String(s ?? ""));
function Ur({ children }: { children: ReactNode }) {
  return (
    <span lang="ur" dir="rtl" className="fc-ur">
      {children}
    </span>
  );
}
const Auto = ({ children }: { children: string }) => (isUrdu(children) ? <Ur>{children}</Ur> : <>{children}</>);

export function PurchasePaper({ m }: { m: PurchasePrint }) {
  const c = m.company;
  const contact = [c.phone, c.shopPhone && `Shop: ${c.shopPhone}`, c.whatsapp && `WhatsApp: ${c.whatsapp}`, c.email, [c.address, c.city].filter(Boolean).join(", "), c.ntn && `NTN: ${c.ntn}`].filter(
    (x): x is string => Boolean(x),
  );
  const align = (a: string) => (a === "right" ? "r" : a === "center" ? "c" : undefined);
  return (
    <article className="fcdoc" data-testid="purchase-paper" aria-label={`Purchase ${m.number}`}>
      {m.cancelled ? (
        <div className="fc-ribbon" data-testid="purchase-ribbon">
          {m.labels.ribbon}
        </div>
      ) : null}
      <div className="fc-head">
        <div>
          {c.logoDataUrl ? (
            <div className="fc-logo">
              <img src={c.logoDataUrl} alt="" />
            </div>
          ) : (
            <div className="fc-logo">{c.logoText}</div>
          )}
          <div className="fc-name" dir="auto" data-testid="company-name">
            {c.businessName ?? c.legalName ?? ""}
          </div>
          {c.tagline ? <div className="fc-tag">{c.tagline}</div> : null}
          {c.taglineUr ? (
            <div className="fc-slogan">
              <Ur>{c.taglineUr}</Ur>
            </div>
          ) : null}
        </div>
        <div className="fc-contact">
          {contact.map((l) => (
            <div key={l}>
              <Auto>{l}</Auto>
            </div>
          ))}
        </div>
      </div>
      <div className="fc-title">{m.title}</div>
      <div className="fc-parties">
        <div>
          <div className="fc-lbl">{m.party.label}</div>
          <div className="fc-shop" data-testid="purchase-party">
            <Auto>{m.party.name ?? "—"}</Auto>
          </div>
        </div>
        <div>
          <div className="fc-lbl">{m.metaLabel}</div>
          <table className="fc-meta">
            <tbody>
              {m.meta
                .filter((r) => r.value)
                .map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td style={r.strong ? { fontWeight: 800 } : undefined} data-testid={r.strong ? "purchase-print-number" : undefined}>
                      <Auto>{r.value}</Auto>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="fc-strip" data-testid="purchase-strip">
        {m.strip.map((s) => (
          <div key={s.label}>
            <i>{s.label}</i>
            <b>
              <Auto>{s.value}</Auto>
            </b>
          </div>
        ))}
      </div>
      <table className="fc-items" data-testid="purchase-lines">
        <thead>
          <tr>
            {m.columns.map((col) => (
              <th key={col.key} className={align(col.align)} style={{ width: `${(col.width * 100).toFixed(1)}%` }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.rows.length === 0 ? (
            <tr>
              <td colSpan={m.columns.length} className="c" style={{ padding: 16, color: "#8c8c99" }}>
                No lines on this document.
              </td>
            </tr>
          ) : (
            m.rows.map((r) => (
              <tr key={r.sr} data-testid="purchase-line">
                {m.columns.map((col) => {
                  if (col.key === "description") {
                    return (
                      <td key={col.key}>
                        {r.descriptionUr ? <Ur>{r.descriptionUr}</Ur> : null}
                        {r.description ? r.descriptionUr ? <span className="fc-sub">{r.description}</span> : r.description : null}
                        {r.godown ? <span className="fc-sub">{r.godown}</span> : null}
                        {r.returnedQuantity ? <span className="fc-sub">{r.returnedQuantity} returned</span> : null}
                      </td>
                    );
                  }
                  const v = (r as unknown as Record<string, string | number>)[col.key];
                  return (
                    <td key={col.key} className={align(col.align)}>
                      {v === undefined || v === null || v === "" ? "—" : <Auto>{String(v)}</Auto>}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr>
            {m.columns.map((col) => {
              const v = (m.itemsFooter as unknown as Record<string, string | number | undefined>)[col.key];
              return (
                <td key={col.key} className={align(col.align)}>
                  {v === undefined ? "" : String(v)}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
      <div className="fc-bottom">
        <div>
          <div className="fc-words" data-testid="purchase-words">
            <div className="fc-lbl">{m.labels.words}</div>
            {m.amountInWords}
          </div>
          {m.payments.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="fc-lbl">{m.labels.payments}</div>
              {m.payments.map((pay) => (
                <div key={pay.paymentId} className="fc-kv">
                  <span>{fmtDate(pay.date)}</span>
                  <b>
                    {pay.receiptNumber}
                    {pay.method ? ` · ${pay.method}` : ""}
                    {pay.reference ? ` · ${pay.reference}` : ""} — {pay.text}
                  </b>
                </div>
              ))}
            </div>
          ) : null}
          {m.notes ? (
            <div style={{ marginTop: 10 }}>
              <div className="fc-lbl">Notes</div>
              <Auto>{m.notes}</Auto>
            </div>
          ) : null}
        </div>
        <div>
          <table className="fc-tot" data-testid="purchase-totals">
            <tbody>
              {m.totals.map((t) => (
                <tr key={t.key} className={t.big ? "big" : t.bold ? "bold" : undefined}>
                  <td>{t.label}</td>
                  <td>{t.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="fc-sigs">
        {m.signatures.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
      <div className="fc-foot">
        <b>{m.footer.thanks}</b>
        {c.businessName}
        {c.tagline ? ` · ${c.tagline}` : ""}
        <div style={{ marginTop: 4, fontSize: 8.5 }}>
          {m.number} · {fmtDate(m.date)}
        </div>
      </div>
      <div className="fc-pagefoot">
        {c.businessName} · {m.number}
      </div>
    </article>
  );
}
