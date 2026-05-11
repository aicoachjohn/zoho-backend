// File: api/getLeadOwner.js
// Deploy to: https://zoho-backend-two.vercel.app/api/getLeadOwner
//
// Returns the Lead Owner (or Contact Owner, for converted leads) for a given PIB_LEAD_ID.
// Called by the enrollment form on page load to populate the hidden `pointOfContact` field.

export default async function handler(req, res) {
  // CORS — only allow the enrollment form to call this
  res.setHeader("Access-Control-Allow-Origin", "https://enroll.proitbridge.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { pib_id } = req.query;
  if (!pib_id) {
    return res.status(400).json({ message: "Missing pib_id" });
  }

  // Helper: parse JSON safely (Zoho sometimes returns empty body on 204)
  async function safeParse(response, label) {
    if (response.status === 204) return {};
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (e) {
      console.error(`JSON parse error in ${label}:`, text);
      return {};
    }
  }

  try {
    // 1. Get fresh access token using refresh token
    const tokenRes = await fetch("https://accounts.zoho.in/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token"
      })
    });

    const tokenData = await safeParse(tokenRes, "TOKEN");

    if (!tokenData.access_token) {
      console.error("Token fetch failed:", tokenData);
      return res.status(500).json({ error: "Token failed", details: tokenData });
    }

    const accessToken = tokenData.access_token;

    // 2. Clean up the pib_id (same normalization as the enrollment handler)
    const pib_id_clean = pib_id.trim().replace(/\s*-\s*/g, "-");

    // 3. Search Leads module first
    const leadRes = await fetch(
      `https://www.zohoapis.in/crm/v2/Leads/search?criteria=(PIB_LEAD_ID:equals:"${pib_id_clean}")`,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
    );
    const leadData = await safeParse(leadRes, "LEAD SEARCH");

    let owner = leadData.data?.[0]?.Owner;
    let source = "Leads";

    // 4. Fall back to Contacts (lead may have already been converted)
    if (!owner) {
      const contactRes = await fetch(
        `https://www.zohoapis.in/crm/v2/Contacts/search?criteria=(PIB_LEAD_ID:equals:"${pib_id_clean}")`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
      );
      const contactData = await safeParse(contactRes, "CONTACT SEARCH");
      owner = contactData.data?.[0]?.Owner;
      source = "Contacts";
    }

    if (!owner) {
      return res.status(404).json({
        message: "Lead not found in Leads or Contacts",
        pib_id: pib_id_clean
      });
    }

    console.log(`Lead owner resolved from ${source}:`, owner.id, owner.name);

    return res.status(200).json({
      ownerId: owner.id,
      ownerName: owner.name,
      ownerEmail: owner.email || null,
      source
    });

  } catch (err) {
    console.error("getLeadOwner error:", err);
    return res.status(500).json({ error: err.message });
  }
}