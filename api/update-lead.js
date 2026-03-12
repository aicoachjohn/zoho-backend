export default async function handler(req, res) {

  // ✅ CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "https://enroll.proitbridge.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { pib_id, ...formFields } = req.body;

  if (!pib_id) {
    return res.status(400).json({ message: "Missing pib_id" });
  }

  try {

    // 🔹 Step 1: Generate fresh access token
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
      return res.status(500).json({
        error: "Failed to generate access token",
        details: tokenData
      });
    }

    const accessToken = tokenData.access_token;

    // 🔹 Step 2: Search Lead by PIB_LEAD_ID
    const searchResponse = await fetch(
      `https://www.zohoapis.in/crm/v2/Leads/search?criteria=(PIB_LEAD_ID:equals:${pib_id})`,
      {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`
        }
      }
    );

    const searchData = await searchResponse.json();

    if (!searchData.data || searchData.data.length === 0) {
      return res.status(404).json({ message: "Lead not found" });
    }

    const leadId = searchData.data[0].id;

    // 🔹 Split full name
    const nameParts = formFields.fullName?.split(" ") || [];
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "NA";

    // 🔹 Map fields to Zoho API names
    const zohoData = {
      Last_Name: formFields.fullName,
      Email: formFields.email,
      Mobile: formFields.mobile,
      Country: formFields.country,
      Street: formFields.address,
      Course_Name: formFields.courseName,
      Course_Type: formFields.courseType,
      Lecture_Language: formFields.lectureLanguage,
      Course_Start_Date: formFields.courseStartDate,
      Payment_Method: formFields.paymentMethod,
      Total_Fee: formFields.totalFee,
      Amount_Paid: formFields.amountPaid,
      Balance_Fee: formFields.remainingAmount,   
      Enrollment_Status: "Enrollment Form Submitted"
    };

    // 🔹 Step 3: Update Lead
    const updateResponse = await fetch(
      `https://www.zohoapis.in/crm/v2/Leads/${leadId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          data: [zohoData]
        })
      }
    );

    const result = await updateResponse.json();

    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}