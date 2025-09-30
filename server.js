import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { XMLParser } from "fast-xml-parser";

dotenv.config();

const app = express();

// CORS – temporar permis pentru toate originile
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

// Middleware pentru JSON body (necesar la /api/xml2json_by_url)
app.use(express.json({ limit: "5mb" }));

// Upload pentru fișiere
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.XML_MAX_SIZE || "5242880", 10) } // 5MB
});

// Parser XML
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: true
});

// Funcții ajutătoare
const toNum = (val) => {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().replace(/\s+/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const toVatRate = (v) => {
  const n = toNum(v);
  if (n === null) return null;
  return n > 1 ? +(n / 100).toFixed(4) : +n.toFixed(4);
};

const safeGet = (obj, path, fallback = null) =>
  path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : null), obj) ?? fallback;

// --- helper: elimină prefixele de namespace (cbc:, cac:, ns2:, etc.)
function stripNs(input) {
  if (Array.isArray(input)) return input.map(stripNs);
  if (input && typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      const key = k.includes(":") ? k.split(":").slice(-1)[0] : k;
      out[key] = stripNs(v);
    }
    return out;
  }
  return input;
}

// --- mapper pentru UBL după stripNs
function mapInvoiceToStandard(json) {
  const root = json.Invoice || json.invoice || json;
  if (!root) return { ok: false, error: "No Invoice root found" };

  // ===== Header =====
  // Numele furnizorului poate fi în PartyName/Name (COMTIM)
  // sau în PartyLegalEntity/RegistrationName (STEJAR), uneori PartyLegalEntity e listă.
  const ple = safeGet(root, "AccountingSupplierParty.Party.PartyLegalEntity");
  const pleRegName = Array.isArray(ple)
    ? (ple[0]?.RegistrationName ?? null)
    : safeGet(root, "AccountingSupplierParty.Party.PartyLegalEntity.RegistrationName");

  const supplierName =
    safeGet(root, "AccountingSupplierParty.Party.PartyName.Name") ||
    pleRegName ||
    safeGet(root, "Supplier.Name");

  const supplierCUI =
    safeGet(root, "AccountingSupplierParty.Party.PartyTaxScheme.CompanyID") ||
    safeGet(root, "Supplier.CUI");

  const invoiceNumber = safeGet(root, "ID") || safeGet(root, "InvoiceNumber");
  const invoiceDate = safeGet(root, "IssueDate") || safeGet(root, "InvoiceDate");
  const currency = safeGet(root, "DocumentCurrencyCode") || safeGet(root, "Currency");

  const legalMonetary = safeGet(root, "LegalMonetaryTotal") || {};
  const totalNoVat =
    toNum(legalMonetary.TaxExclusiveAmount?.["#text"] ?? legalMonetary.TaxExclusiveAmount) ??
    toNum(legalMonetary.LineExtensionAmount?.["#text"] ?? legalMonetary.LineExtensionAmount);

  const totalWithVat =
    toNum(legalMonetary.TaxInclusiveAmount?.["#text"] ?? legalMonetary.TaxInclusiveAmount) ?? null;

  // ===== Lines (UBL: InvoiceLine) =====
  let rawLines = root.InvoiceLine || root.invoiceLine || [];
  if (!Array.isArray(rawLines)) rawLines = [rawLines];
  rawLines = rawLines.filter(Boolean);

  const items = rawLines.map((ln, idx) => {
    // Denumire
    const name =
      safeGet(ln, "Item.Name") ||
      safeGet(ln, "Item.Description") ||
      safeGet(ln, "Description") ||
      `Item ${idx + 1}`;

    // Cantitate + U.M.
    const invQty = ln.InvoicedQuantity;
    const qtyInvoiced = toNum(invQty?.["#text"] ?? invQty);
    const unit =
      invQty?.["@_unitCode"] ||
      invQty?.unitCode ||
      safeGet(ln, "Price.BaseQuantity.@_unitCode") ||
      safeGet(ln, "Price.BaseQuantity.unitCode") ||
      null;

    // Preț unitar fără TVA (Price/PriceAmount)
    const priceNoVat =
      toNum(ln.Price?.PriceAmount?.["#text"] ?? ln.Price?.PriceAmount) ??
      toNum(safeGet(ln, "UnitPrice"));

    // Valoarea liniei fără TVA: LineExtensionAmount (fallback: qty * price)
    const lineExt = safeGet(ln, "LineExtensionAmount");
    const valueNoVat =
      toNum(lineExt?.["#text"] ?? lineExt) ??
      (qtyInvoiced != null && priceNoVat != null
        ? +(qtyInvoiced * priceNoVat).toFixed(4)
        : null);

    // Cotă TVA (Percent) -> fracție (19 -> 0.19)
    const vatPercent =
      toNum(safeGet(ln, "Item.ClassifiedTaxCategory.Percent")) ??
      toNum(safeGet(ln, "TaxTotal.TaxSubtotal.TaxCategory.Percent")) ??
      null;
    const vatRate = vatPercent != null ? toVatRate(vatPercent) : null;

    // Valoare TVA pe linie – preferăm TaxAmount din XML dacă există
    const explicitVat =
      toNum(safeGet(ln, "TaxTotal.TaxSubtotal.TaxAmount.#text")) ??
      toNum(safeGet(ln, "TaxTotal.TaxSubtotal.TaxAmount")) ??
      toNum(safeGet(ln, "TaxTotal.TaxAmount.#text")) ??
      toNum(safeGet(ln, "TaxTotal.TaxAmount"));

    const vatValue =
      explicitVat != null
        ? +explicitVat.toFixed(4)
        : valueNoVat != null && vatRate != null
          ? +(valueNoVat * vatRate).toFixed(4)
          : null;

    return {
      product_name: name,
      unit,
      qty_invoiced: qtyInvoiced,
      qty_received: null,
      lot: null,
      price_no_vat: priceNoVat,   // preț unitar fără TVA
      value_no_vat: valueNoVat,   // valoare linie fără TVA
      vat_rate: vatRate,          // cotă TVA (fracție)
      vat_value: vatValue         // valoare TVA pe linie (din XML dacă există)
    };
  });

  const header = {
    supplier: supplierName || null,
    cui: supplierCUI || null,
    invoice_number: invoiceNumber || null,
    invoice_date: invoiceDate || null,
    currency: currency || null,
    total_no_vat: totalNoVat ?? null,
    total_with_vat: totalWithVat ?? null
  };

  return { ok: true, header, items };
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// XML ca RAW text
app.post(
  "/api/xml2json",
  express.text({ type: ["text/*", "application/xml"], limit: process.env.XML_MAX_SIZE || "5mb" }),
  (req, res) => {
    try {
      if (!req.body) return res.status(400).json({ ok: false, error: "Empty body" });
      const json = parser.parse(req.body);
      const normalized = stripNs(json);
      const mapped = mapInvoiceToStandard(normalized);
      if (!mapped.ok) return res.status(422).json(mapped);
      return res.json(mapped);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || "Parse error" });
    }
  }
);

// XML ca fișier (multipart form-data, field name: file)
app.post("/api/xml2json_file", upload.any(), (req, res) => {
  try {
    const f = (req.files && req.files[0]) ? req.files[0] : null;
    if (!f) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const xml = f.buffer.toString("utf8");
    const json = parser.parse(xml);
    const normalized = stripNs(json);
    const mapped = mapInvoiceToStandard(normalized);
    if (!mapped.ok) return res.status(422).json(mapped);
    return res.json(mapped);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "Parse error" });
  }
});

// XML prin URL (Body JSON: { "url": "https://..." })
app.post("/api/xml2json_by_url", async (req, res) => {
  try {
    let url = req.body?.url;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'url' in JSON body" });
    }
    if (url.startsWith("//")) url = "https:" + url; // fix pt. scheme-relative
    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(400).json({ ok: false, error: `Fetch failed with HTTP ${resp.status}` });
    }
    const xml = await resp.text();
    const json = parser.parse(xml);
    const normalized = stripNs(json);
    const mapped = mapInvoiceToStandard(normalized);
    if (!mapped.ok) return res.status(422).json(mapped);
    return res.json(mapped);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "Parse error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("xml2json service running on port", PORT);
});
