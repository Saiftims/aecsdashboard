/** The customer referral email: asks a firm on Silent Witness to introduce
 * another firm, for a $500 gift card.
 *
 * The design follows the referral page, silentwitness.ai/referral: the
 * outlined "Referral program" pill, the two-line headline with the second line
 * in brand blue, the navy gift card, the numbered steps and the closing
 * "Know a firm that should see this?" panel. The offer, the three steps and
 * the small print restate that page and its program terms (read 2026-11-22);
 * if the page changes, change this to match.
 *
 * Email clients ignore stylesheets and most modern CSS, so the layout is
 * tables with inline styles and the type falls back from Inter to the system
 * sans-serif (Apple Mail loads Inter; Gmail and Outlook do not). The gift card
 * is an image because its glow cannot be drawn in email CSS; it is served from
 * this app's `public/email/` folder. The logo is the site's hosted PNG (Gmail
 * drops SVG). */

const INK = "#061022";
const BODY = "#424245";
const MUTED = "#5b6270";
const BLUE = "#3560d8";
const NAVY = "#0b1734";
const WASH = "#eef2fe";
const PILL_BORDER = "#a5b9ed";
const CANVAS = "#f4f6fa";
const HAIRLINE = "#e9eaeb";
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const LOGO = "https://silentwitness.ai/logo.png";

/** Where this app's `public/email/` images are served from. */
export const EMAIL_ASSET_BASE = "https://gtm-dashboard-fawn.vercel.app/email";

export const REFERRAL_REWARD = "$500";
/** The referral page: the form a customer fills in, and the program terms. */
export const REFERRAL_URL = "https://silentwitness.ai/referral";
const TERMS_URL = `${REFERRAL_URL}#terms`;

/** The three steps as the referral page states them. */
const STEPS: { title: string; body: string }[] = [
  { title: "Tell us who", body: "Fill in a short form with your details and theirs. A name and an email is enough." },
  { title: "We reach out", body: "Within one business day, we walk them through one of their real cases, free. We only mention you with your OK." },
  { title: `You earn ${REFERRAL_REWARD}`, body: `When they sign up, a ${REFERRAL_REWARD} gift card lands in your inbox.` },
];

export interface ReferralEmailInput {
  /** Recipient's first name; the greeting drops the name when absent. */
  firstName?: string | null;
  /** Where the buttons go; the referral page unless overridden. */
  ctaUrl?: string;
  /** One-click unsubscribe link, required before this goes to customers. */
  unsubscribeUrl?: string | null;
  /** Postal address for the footer, required before this goes to customers. */
  postalAddress?: string | null;
  /** Overrides where the gift-card image loads from (local previews). */
  assetBase?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function referralEmail(input: ReferralEmailInput): { subject: string; preheader: string; html: string; text: string } {
  const name = (input.firstName ?? "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const ctaUrl = input.ctaUrl ?? REFERRAL_URL;
  const card = `${input.assetBase ?? EMAIL_ASSET_BASE}/referral-card.jpg`;
  const subject = `${REFERRAL_REWARD} for every firm you refer to Silent Witness`;
  const preheader = `Expert intelligence at intake, for the attorneys you know. A ${REFERRAL_REWARD} gift card for every firm that signs up.`;
  // The opener is the owner's positioning line (2026-11-22): "Silent Witness
  // delivers expert intelligence at intake. Our analysis helps firms settle
  // faster and build up stronger cases."
  const intro = "Silent Witness delivers expert intelligence at intake. Our analysis helps firms settle faster and build stronger cases.";
  const offer = `Now put it in front of the attorneys you know. Introduce a firm, and when they sign up we send you a ${REFERRAL_REWARD} gift card. No cap.`;
  const cta = "Refer a firm";
  const cardAlt = `${REFERRAL_REWARD} gift card per firm that signs up. Issued to you. No limit.`;
  const finePrint = "The firm must be new to Silent Witness and sign up within 90 days of our first conversation. Gift cards are issued within 30 days of their first paid invoice.";
  const closeTitle = "Know a firm that should see this?";
  const closeBody = `We make the introduction. You earn ${REFERRAL_REWARD} when they sign up.`;
  const thanks = "Thank you for trusting us with your cases.";
  const signoff = "The Silent Witness team";
  const reason = "You are receiving this because your firm is a Silent Witness customer.";

  const button = (align: "left" | "center") => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"${align === "center" ? ' align="center"' : ""}><tr>
              <td bgcolor="${BLUE}" style="background:${BLUE};border-radius:10px;">
                <a href="${esc(ctaUrl)}" style="display:inline-block;padding:14px 26px;font:600 15px/20px ${FONT};color:#ffffff;text-decoration:none;border-radius:10px;">${cta}&nbsp;&nbsp;&rarr;</a>
              </td>
            </tr></table>`;

  const step = (s: { title: string; body: string }, i: number) => `
              <tr>
                <td width="52" valign="top" style="padding:22px 0 22px 24px;${i ? `border-top:1px solid ${HAIRLINE};` : ""}font:500 12px/26px ${MONO};letter-spacing:0.08em;color:${BLUE};">0${i + 1}</td>
                <td valign="top" style="padding:22px 24px 22px 0;${i ? `border-top:1px solid ${HAIRLINE};` : ""}">
                  <div style="font:600 18px/26px ${FONT};letter-spacing:-0.015em;color:${INK};">${esc(s.title)}</div>
                  <div style="margin-top:4px;font:400 15px/23px ${FONT};color:${BODY};">${esc(s.body)}</div>
                </td>
              </tr>`;

  const footerLinks = [
    `<a href="https://silentwitness.ai" style="color:${MUTED};text-decoration:underline;">silentwitness.ai</a>`,
    `<a href="${TERMS_URL}" style="color:${MUTED};text-decoration:underline;">Program terms</a>`,
    input.unsubscribeUrl ? `<a href="${esc(input.unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>` : null,
  ].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  @media only screen and (max-width: 620px) {
    .sw-outer { padding: 16px 8px 28px 8px !important; }
    .sw-pad { padding-left: 24px !important; padding-right: 24px !important; }
    .sw-h1 { font-size: 38px !important; line-height: 42px !important; }
    .sw-h2 { font-size: 24px !important; line-height: 30px !important; }
    .sw-lead { font-size: 18px !important; line-height: 28px !important; }
    .sw-close { padding: 28px 22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CANVAS};-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CANVAS};font-size:1px;line-height:1px;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background:${CANVAS};">
  <tr>
    <td class="sw-outer" align="center" style="padding:40px 12px 40px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:24px;box-shadow:0 8px 24px -4px rgba(6,16,34,0.08);">
        <tr>
          <td class="sw-pad" style="padding:36px 48px 0 48px;">
            <a href="https://silentwitness.ai" style="text-decoration:none;"><img src="${LOGO}" width="158" height="15" alt="Silent Witness" style="display:block;border:0;width:158px;height:15px;"></a>
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:48px 48px 0 48px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="border:1px solid ${PILL_BORDER};border-radius:999px;padding:5px 14px;font:600 13px/20px ${FONT};color:${INK};">Referral program</td>
            </tr></table>
            <h1 class="sw-h1" style="margin:18px 0 0 0;font:700 48px/52px ${FONT};letter-spacing:-0.03em;color:${INK};">Refer a firm.<br><span style="color:${BLUE};">Earn ${REFERRAL_REWARD}.</span></h1>
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:28px 48px 0 48px;">
            <p style="margin:0 0 14px 0;font:400 16px/26px ${FONT};color:${BODY};">${esc(greeting)}</p>
            <p class="sw-lead" style="margin:0 0 14px 0;font:500 20px/30px ${FONT};letter-spacing:-0.015em;color:${INK};">${esc(intro)}</p>
            <p style="margin:0;font:400 16px/26px ${FONT};color:${BODY};">${esc(offer)}</p>
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:28px 48px 0 48px;">${button("left")}
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:40px 48px 0 48px;">
            <a href="${esc(ctaUrl)}" style="text-decoration:none;"><img src="${esc(card)}" width="504" alt="${esc(cardAlt)}" style="display:block;border:0;width:100%;max-width:504px;height:auto;border-radius:22px;box-shadow:0 28px 56px -24px rgba(16,34,75,0.55);background:${NAVY};color:#ffffff;font:600 16px/24px ${FONT};"></a>
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:56px 48px 0 48px;">
            <div style="font:600 13px/20px ${FONT};color:${BLUE};">How it works</div>
            <h2 class="sw-h2" style="margin:6px 0 0 0;font:700 28px/34px ${FONT};letter-spacing:-0.025em;color:${INK};">Three steps. <span style="color:${BLUE};">One introduction.</span></h2>
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:22px 48px 0 48px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${HAIRLINE};border-radius:18px;border-collapse:separate;">${STEPS.map(step).join("")}
            </table>
            <div style="margin-top:16px;font:400 13px/20px ${FONT};color:${MUTED};">${esc(finePrint)} <a href="${TERMS_URL}" style="color:${BLUE};text-decoration:underline;">Program terms</a></div>
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:44px 48px 0 48px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${WASH}" style="background:${WASH};border-radius:18px;">
              <tr>
                <td class="sw-close" align="center" style="padding:36px 24px;">
                  <div class="sw-h2" style="font:700 26px/32px ${FONT};letter-spacing:-0.025em;color:${INK};">${esc(closeTitle)}</div>
                  <div style="margin:8px 0 22px 0;font:400 15px/24px ${FONT};color:${BODY};">${esc(closeBody)}</div>${button("center")}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="sw-pad" style="padding:36px 48px 44px 48px;font:400 16px/26px ${FONT};color:${BODY};">
            <p style="margin:0;">${esc(thanks)}</p>
            <p style="margin:4px 0 0 0;color:${INK};font-weight:600;">${esc(signoff)}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
        <tr>
          <td class="sw-pad" align="center" style="padding:24px 48px 0 48px;font:400 12px/19px ${FONT};color:${MUTED};">
            ${esc(reason)}<br>
            ${footerLinks}${input.postalAddress ? `<br>${esc(input.postalAddress)}` : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `Refer a firm. Earn ${REFERRAL_REWARD}.`,
    "",
    greeting,
    "",
    intro,
    "",
    offer,
    "",
    `${cta}: ${ctaUrl}`,
    "",
    "Three steps. One introduction.",
    ...STEPS.map((s, i) => `${i + 1}. ${s.title}: ${s.body}`),
    "",
    finePrint,
    `Program terms: ${TERMS_URL}`,
    "",
    closeTitle,
    closeBody,
    `${cta}: ${ctaUrl}`,
    "",
    thanks,
    signoff,
    "",
    reason,
    "silentwitness.ai",
    ...(input.postalAddress ? [input.postalAddress] : []),
    ...(input.unsubscribeUrl ? [`Unsubscribe: ${input.unsubscribeUrl}`] : []),
  ].join("\n");

  return { subject, preheader, html, text };
}
