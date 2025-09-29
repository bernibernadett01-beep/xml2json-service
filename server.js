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

// Funcție de mapare (simplificată pentru demo, adaugă-ți tu restul câmpurilor necesare)
function mapInvoiceToStandard(json) {
  const root = json.Invoice || json.invoice || json["ns2:Invoice"] || json;
  if (!root) return { ok: false, error: "No Invoice root found" };

  const supplierName =
    safeGet(root, "AccountingSupplierParty.Party.PartyName.Name") ||
    safeGet(root, "Supplier.Name");

  const invoiceNumber = safeGet(root, "ID") || safeGet(root, "InvoiceNumber");
  const invoiceDate = safeGet(root, "IssueDate") || safeGet(root, "InvoiceDate");
  const currency = safeGet(root, "DocumentCurrencyCode") || safeGet(root, "Currency");

  const legalMonetary = safeGet(root, "LegalMonetaryTotal") || {};
  const totalNoVat = toNum(legalMonetary.TaxExclusiveAmount || legalMonetary.LineExtensionAmount);
  const totalWithVat = toNum(legalMonetary.TaxInclusiveAmount);

  let rawLines = root.InvoiceLine || root.invoiceLine || [];
  if (!Array.isArray(rawLines)) rawLines = [rawLines];

  const items = rawLines.map((ln, idx) => {
    const name = safeGet(ln, "Item.Name") || safeGet(ln, "Description") || `Item ${idx + 1}`;
    const unit = safeGet(ln, "InvoicedQuantity.@_unitCode") || null;
    const qtyInvoiced =
      toNum(ln.InvoicedQuantity?.["#text"] ?? ln.InvoicedQuantity) ??
      toNum(ln.Quantity);
    const priceNoVat = toNum(ln.Price?.PriceAmount?.["#text"] ?? ln.Price?.PriceAmount);
    const vatPercent =
      toNum(safeGet(ln, "TaxTotal.TaxSubtotal.TaxCategory.Percent")) ?? null;
    const vatRate = vatPercent !== null ? toVatRate(vatPercent) : null;
    const valueNoVat =
      qtyInvoiced !== null && priceNoVat !== null ? +(qtyInvoiced * priceNoVat).toFixed(4) : null;
    const vatValue =
      valueNoVat !== null && vatRate !== null ? +(valueNoVat * vatRate).toFixed(4) : null;

    return {
      product_name: name,
      unit: unit,
      qty_invoiced: qtyInvoiced,
      qty_received: null,
      lot: null,
      price_no_vat: priceNoVat,
      vat_rate: vatRate,
      value_no_vat: valueNoVat,
      vat_value: vatValue
    };
  });

  const header = {
    supplier: supplierName || null,
    invoice_number: invoiceNumber || null,
    invoice_date: invoiceDate || null,
    currency: currency || null,
    total_no_vat: totalNoVat,
    total_with_vat: totalWithVat
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
      const mapped = mapInvoiceToStandard(json);
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
    const mapped = mapInvoiceToStandard(json);
    if (!mapped.ok) return res.status(422).json(mapped);
    return res.json(mapped);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "Parse error" });
  }
});

// XML prin URL (Body JSON: { "url": "https://..." })
app.post("/api/xml2json_by_url", async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'url' in JSON body" });
    }
    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(400).json({ ok: false, error: `Fetch failed with HTTP ${resp.status}` });
    }
    const xml = await resp.text();
    const json = parser.parse(xml);
    const mapped = mapInvoiceToStandard(json);
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
