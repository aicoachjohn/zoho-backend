export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { lead_id, ...formFields } = req.body;

  if (!lead_id) {
    return res.status(400).json({ message: "Missing lead_id" });
  }

  try {

    // 🔹 Generate fresh access token using refresh token
    const tokenResponse = await fetch(
      "https://accounts.zoho.in/oauth/v2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          refresh_token: process.env.ZOHO_REFRESH_TOKEN,
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          grant_type: "refresh_token"
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return res.status(500).json({ error: "Failed to generate access token", details: tokenData });
    }

    const accessToken = tokenData.access_token;

    // 🔹 Update Zoho Lead
    const response = await fetch(
      `https://www.zohoapis.in/crm/v2/Leads/${lead_id}`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          data: [
            {
              ...formFields,
              Enrollment_Status: "Enrollment Form Submitted"
            }
          ]
        })
      }
    );

    const result = await response.json();

    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}