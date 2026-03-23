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
)
;

const searchData = await searchResponse.json();

if (!searchData.data || searchData.data.length === 0) {
  return res.status(404).json({ message: "Lead not found" });
}

const leadId = searchData.data[0].id;

// 🔹 Step 3: Update Lead (REMOVE PAYMENT FIELDS)
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
  Enrollment_Status: "Enrollment Form Submitted"
};

await fetch(
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

// 🔹 Step 4: Search Deal
const dealSearchResponse = await fetch(
  `https://www.zohoapis.in/crm/v2/Deals/search?criteria=(PIB_LEAD_ID:equals:${pib_id})`,
  {
    method: "GET",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`
    }
  }
);

const dealSearchData = await dealSearchResponse.json();

// 🔹 Step 5: Deal Payload (CORRECT API NAMES)
const dealPayload = {
  Deal_Name: formFields.fullName,

  Pipeline: "Course Holding Pipeline",
  Stage: "Hold Discussion",

  Payment_Method: "Course Hold",

  Total_Fee: formFields.totalFee,
  Amount_Paid: formFields.amountPaid,
  Course_Holding_Amount: formFields.amountPaid,

  Payment_Status: "Partial",

  PIB_LEAD_ID: pib_id
};

// 🔹 Step 6: Create or Update Deal
if (!dealSearchData.data || dealSearchData.data.length === 0) {

  // CREATE DEAL
  await fetch(
    "https://www.zohoapis.in/crm/v2/Deals",
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: [dealPayload]
      })
    }
  );

} else {

  const dealId = dealSearchData.data[0].id;

  // UPDATE DEAL
  await fetch(
    `https://www.zohoapis.in/crm/v2/Deals/${dealId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: [dealPayload]
      })
    }
  );
}

return res.status(200).json({ message: "Success" });


} catch (error) {
return res.status(500).json({ error: error.message });
}
}
