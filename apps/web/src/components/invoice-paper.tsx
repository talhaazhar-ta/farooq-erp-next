import type { ReactNode } from "react";
import { CLASSIC_LABELS, type InvoicePrint } from "@farooq/shared";
import { fmtDate } from "../lib/format";

/**
 * The printed sales invoice, drawn from the ONE `InvoicePrint` model the server builds — in the classic layout (the
 * shop's existing sheet, the live setting) or the standard one. This is a port of the legacy `Paper.classicHtml` /
 * `Paper.html`: every figure and every label comes from the model (the wording is `INVOICE_PRINT_LABELS` /
 * `CLASSIC_LABELS` on the server side); nothing here is computed or retyped except the few field captions the legacy
 * standard layout drew itself (Owner, Mobile, …). Paper colours are fixed (`invoice-paper.css`).
 */

const isUrdu = (s: string | null | undefined): boolean => /[؀-ۿ]/.test(String(s ?? ""));
const dmy = (iso: string): string => {
  const p = iso.slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
};

/** A run of Urdu, shaped right-to-left. */
function Ur({ children }: { children: ReactNode }) {
  return (
    <span lang="ur" dir="rtl" className="fc-ur">
      {children}
    </span>
  );
}
/** Text in whichever script it is written. */
const Auto = ({ children }: { children: string }) => (isUrdu(children) ? <Ur>{children}</Ur> : <>{children}</>);

export function InvoicePaper({ m }: { m: InvoicePrint }) {
  return m.template === "classic" ? <ClassicSheet m={m} /> : <StandardSheet m={m} />;
}

function Ribbon({ m }: { m: InvoicePrint }) {
  if (m.cancelled) return <div className="fc-ribbon" data-testid="invoice-ribbon">{m.labels.ribbon.cancelled}</div>;
  if (m.isDraft) return <div className="fc-ribbon" data-testid="invoice-ribbon">{m.labels.ribbon.draft}</div>;
  return null;
}

function Footer({ m }: { m: InvoicePrint }) {
  const f = m.footer;
  if (!f.thanks && !f.terms && !f.bank) return null;
  return (
    <div className="cl-foot">
      {f.thanks ? <b>{f.thanks}</b> : null}
      {f.terms ? <div>{f.terms}</div> : null}
      {f.bank ? <div>{f.bank}</div> : null}
    </div>
  );
}

/* ── classic ─────────────────────────────────────────────────────────── */

function ClassicSheet({ m }: { m: InvoicePrint }) {
  const c = m.company;
  const cl = m.classic;
  return (
    <article className="fcdoc classic" data-testid="invoice-paper" data-template="classic" aria-label={`Invoice ${m.number}`}>
      <Ribbon m={m} />
      <div className="cl-title">{m.title || "INVOICE"}</div>
      <div className="cl-head">
        <div className="l">
          <div className="cl-en" dir="auto" data-testid="company-name">{c.businessName ?? c.legalName ?? ""}</div>
          {c.tagline ? <div className="cl-mark">{c.tagline}</div> : null}
          <div className="cl-mark">
            {c.logoText} · <Ur>{CLASSIC_LABELS.trademarkUr}</Ur>
          </div>
        </div>
        <div className="r">
          {c.taglineUr ? <div><Auto>{c.taglineUr}</Auto></div> : null}
          {c.address ? <div><Auto>{c.address}</Auto></div> : null}
          {c.slogan ? <div><Ur>{c.slogan}</Ur></div> : null}
        </div>
      </div>
      <div className="cl-phones">
        {cl.phones.map((p, i) => (
          <span key={p}>
            {i > 0 ? <> &nbsp;·&nbsp; </> : null}
            <Auto>{p}</Auto>
          </span>
        ))}
      </div>
      <div className="cl-parties">
        <div className="cl-bill">
          <span className="tag">{CLASSIC_LABELS.billToParty}</span>
          <b data-testid="invoice-party"><Auto>{m.party.shop ?? "—"}</Auto></b>
          <div>{cl.contact}</div>
          <div><Ur>{cl.regionUr}</Ur></div>
        </div>
        <table className="cl-meta">
          <tbody>
            <tr><td>{CLASSIC_LABELS.serial}</td><td>{cl.serial || "—"}</td></tr>
            <tr><td>{CLASSIC_LABELS.invNo}</td><td data-testid="invoice-invno">{cl.invNo}</td></tr>
            <tr><td>{CLASSIC_LABELS.date}</td><td>{dmy(m.date)}</td></tr>
            <tr><td>{CLASSIC_LABELS.idNo}</td><td>{cl.idNo || "—"}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="cl-body">
        <table className="cl-t" data-testid="classic-ledger">
          <thead>
            <tr>
              <th>{CLASSIC_LABELS.ledger.date} <Ur>{CLASSIC_LABELS.ledger.dateUr}</Ur></th>
              <th className="r">{CLASSIC_LABELS.ledger.dr} <Ur>{CLASSIC_LABELS.ledger.drUr}</Ur></th>
              <th className="r">{CLASSIC_LABELS.ledger.cr} <Ur>{CLASSIC_LABELS.ledger.crUr}</Ur></th>
            </tr>
          </thead>
          <tbody>
            {cl.ledgerRows.length === 0 ? (
              <tr><td colSpan={3} className="c" style={{ color: "#9a9aa6" }}>{CLASSIC_LABELS.ledger.none}</td></tr>
            ) : (
              cl.ledgerRows.map((r, i) => (
                <tr key={i} data-testid="classic-ledger-row">
                  <td>{r.date}</td>
                  <td className="r">{r.dr}</td>
                  <td className="r">{r.cr}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>{CLASSIC_LABELS.ledger.subtotal}</td>
              <td className="r">{cl.ledgerTotals.dr}</td>
              <td className="r">{cl.ledgerTotals.cr}</td>
            </tr>
          </tfoot>
        </table>
        <table className="cl-t" data-testid="classic-lines">
          <thead>
            <tr>
              <th>{CLASSIC_LABELS.products.product}</th>
              <th className="r">{CLASSIC_LABELS.products.price}</th>
              <th className="r">{CLASSIC_LABELS.products.quantity}</th>
              <th className="r">{CLASSIC_LABELS.products.amounts}</th>
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r) => (
              <tr key={r.sr} data-testid="invoice-line">
                <td className="cl-prod">
                  {r.descriptionUr ? <Ur>{r.descriptionUr}</Ur> : r.description}
                  {r.descriptionUr && r.description ? <span className="en">{r.description}</span> : null}
                </td>
                <td className="r">{r.rate}</td>
                <td className="r">{r.qty.replace(/ Bags?$/, "")}</td>
                <td className="r">{r.amount}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{CLASSIC_LABELS.products.subtotal}</td>
              <td />
              <td className="r">{Number(cl.qtyTotal).toLocaleString("en-US")}.00</td>
              <td className="r">{cl.lineTotal}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="cl-box" data-testid="classic-box">
        {cl.box.map((t, i) => (
          <div key={i} className={t.big ? "big" : undefined}>
            <span>{t.label}</span>
            <i>{t.labelUr ? <Ur>{t.labelUr}</Ur> : null}</i>
            <b>{t.text}</b>
          </div>
        ))}
      </div>
      {cl.remarks ? (
        <div className="cl-remarks">
          {CLASSIC_LABELS.remarks}
          <Auto>{cl.remarks}</Auto>
        </div>
      ) : null}
      <div className="cl-sigs">
        {m.signatures.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
      <Footer m={m} />
      <div className="fc-pagefoot">
        {c.businessName} · {m.number}
      </div>
    </article>
  );
}

/* ── standard ────────────────────────────────────────────────────────── */

function StandardSheet({ m }: { m: InvoicePrint }) {
  const c = m.company;
  const contact = [c.phone, c.shopPhone && `Shop: ${c.shopPhone}`, c.whatsapp && `WhatsApp: ${c.whatsapp}`, c.email, c.website, [c.address, c.city].filter(Boolean).join(", "), c.ntn && `NTN: ${c.ntn}`, c.registrationNo && `Reg: ${c.registrationNo}`].filter(
    (x): x is string => Boolean(x),
  );
  const p = m.party;
  const partyRows: [string, string | null][] = [
    ["Owner", p.owner],
    ["Customer code", p.code],
    ["Mobile", p.contact],
    ["WhatsApp", p.whatsapp],
    ["Address", p.address],
    ["Region", p.region],
    ["Market / route", p.market],
  ];
  const align = (a: string) => (a === "right" ? "r" : a === "center" ? "c" : undefined);
  return (
    <article className="fcdoc" data-testid="invoice-paper" data-template="standard" aria-label={`Invoice ${m.number}`}>
      <Ribbon m={m} />
      <div className="fc-head">
        <div>
          {c.logoDataUrl ? (
            <div className="fc-logo">
              <img src={c.logoDataUrl} alt="" />
            </div>
          ) : (
            <div className="fc-logo">{c.logoText}</div>
          )}
          <div className="fc-name" dir="auto" data-testid="company-name">{c.businessName ?? c.legalName ?? ""}</div>
          {c.tagline ? <div className="fc-tag">{c.tagline}</div> : null}
          {c.taglineUr ? <div className="fc-slogan"><Ur>{c.taglineUr}</Ur></div> : null}
          {c.slogan ? <div className="fc-slogan"><Ur>{c.slogan}</Ur></div> : null}
        </div>
        <div className="fc-contact">
          {contact.map((l) => (
            <div key={l}><Auto>{l}</Auto></div>
          ))}
        </div>
      </div>
      <div className="fc-title">{m.title}</div>
      <div className="fc-parties">
        <div>
          <div className="fc-lbl">
            {p.label} {p.labelUr ? <Ur>{p.labelUr}</Ur> : null}
          </div>
          <div className="fc-shop" data-testid="invoice-party"><Auto>{p.shop ?? "—"}</Auto></div>
          {partyRows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="fc-kv">
                <span>{k}</span>
                <b><Auto>{v!}</Auto></b>
              </div>
            ))}
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
                    <td style={r.strong ? { fontWeight: 800 } : undefined} data-testid={r.strong ? "invoice-number" : undefined}>
                      <Auto>{r.value}</Auto>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
      {m.strip.length > 0 ? (
        <div className="fc-strip">
          {m.strip.map((s) => (
            <div key={s.label}>
              <i>{s.label}</i>
              <b><Auto>{s.value}</Auto></b>
            </div>
          ))}
        </div>
      ) : null}
      <table className="fc-items" data-testid="standard-lines">
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
              <tr key={r.sr} data-testid="invoice-line">
                {m.columns.map((col) => {
                  if (col.key === "description") {
                    return (
                      <td key={col.key}>
                        {r.descriptionUr ? <Ur>{r.descriptionUr}</Ur> : null}
                        {r.description ? (r.descriptionUr ? <span className="fc-sub">{r.description}</span> : r.description) : null}
                        {r.batch ? <span className="fc-sub">Batch {r.batch}</span> : null}
                        {r.returned ? <span className="fc-sub">{r.returned} returned</span> : null}
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
          {m.amountInWords ? (
            <div className="fc-words" data-testid="invoice-words">
              <div className="fc-lbl">{m.labels.words}</div>
              {m.amountInWords}
            </div>
          ) : null}
          {m.payments.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="fc-lbl">Payments against this document</div>
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
          <table className="fc-tot" data-testid="invoice-totals">
            <tbody>
              {m.totals.map((t) => (
                <tr key={t.key} className={t.big ? "big" : t.bold ? "bold" : undefined}>
                  <td>
                    {t.label} {t.labelUr ? <Ur>{t.labelUr}</Ur> : null}
                  </td>
                  <td>{t.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {m.ledger.length > 0 ? (
        <div className="fc-ledger" data-testid="invoice-ledger">
          {m.ledger.map((r) => (
            <div key={r.label}>
              <span>
                {r.label} {r.labelUr ? <Ur>{r.labelUr}</Ur> : null}
              </span>
              <b>{r.text}</b>
            </div>
          ))}
        </div>
      ) : null}
      <div className="fc-sigs">
        {m.signatures.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
      <div className="fc-foot">
        {m.footer.thanks ? <b>{m.footer.thanks}</b> : null}
        {c.businessName}
        {c.tagline ? ` · ${c.tagline}` : ""}
        {m.footer.terms ? <div style={{ marginTop: 3 }}>{m.footer.terms}</div> : null}
        {m.footer.bank ? <div style={{ marginTop: 3 }}>{m.footer.bank}</div> : null}
        <div style={{ marginTop: 4, fontSize: 8.5 }}>
          {m.number} · issued {fmtDate(m.date)}
        </div>
      </div>
      <div className="fc-pagefoot">
        {c.businessName} · {m.number}
      </div>
    </article>
  );
}
