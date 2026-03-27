export default async function handler(req, res) {

res.setHeader("Access-Control-Allow-Origin", "https://enroll.proitbridge.com");
res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");

if (req.method === "OPTIONS") return res.status(200).end();
if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

const { pib_id, ...formFields } = req.body;

if (!pib_id) return res.status(400).json({ message: "Missing pib_id" });


async function safeParse(response, label) {
  const text = await response.text();
  console.log(`🔍 ${label}:`, text);

  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    console.error(`❌ JSON Parse Error in ${label}:`, text);
    return {};
  }
}

try {

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
  return res.status(500).json({ error: "Token failed", details: tokenData });
}

const accessToken = tokenData.access_token;


const leadRes = await fetch(
  `https://www.zohoapis.in/crm/v2/Leads/search?criteria=(PIB_LEAD_ID:equals:${encodeURIComponent(pib_id)})`,
  { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
);

const leadData = await safeParse(leadRes, "LEAD SEARCH");

if (!leadData.data || leadData.data.length === 0) {
  return res.status(404).json({ message: "Lead not found" });
}

const lead = leadData.data[0];
const leadId = lead.id;
const leadOwnerId = lead.Owner.id;


await fetch(`https://www.zohoapis.in/crm/v2/Leads/${leadId}`, {
  method: "PUT",
  headers: {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    data: [{
      Last_Name: formFields.fullName,
      Email: formFields.email,
      Mobile: formFields.mobile,
      Country: formFields.country,
      Complete_Address: formFields.address,
      Course_Name: formFields.courseName,
      Course_Type: formFields.courseType,
      Lecture_Language: formFields.lectureLanguage,
      Course_Start_Date: formFields.courseStartDate,
      Enrollment_Status: "Enrollment Form Submitted"
    }]
  })
});

// 🔹 PAYMENT PLAN LOGIC
let pipeline = "";
let stage = "";

const paymentMethod = formFields.paymentMethod?.trim();
const paymentPlan = formFields.paymentPlan?.trim(); 

if (paymentMethod === "Course Hold") {
  pipeline = "Course Holding Pipeline";
  stage = "Hold Discussion";
}

else if (paymentMethod === "Single Shot") {
  pipeline = "Single Shot Pipeline";
  stage = "Payment Pending";
}

else if (paymentMethod === "Installment") {
  pipeline = "Installments Pipeline";
  stage = "Plan Confirmed";
}


const dealRes = await fetch(
  `https://www.zohoapis.in/crm/v2/Deals/search?criteria=(PIB_LEAD_ID:equals:${encodeURIComponent(pib_id)})`,
  { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
);

const dealData = await safeParse(dealRes, "DEAL SEARCH");


const dealPayload = {
  Deal_Name: formFields.fullName,
  Owner: { id: leadOwnerId },

  Pipeline: pipeline,
  Stage: stage,

  Payment_Method: paymentMethod,
  Payment_Plan: paymentPlan, 

  Total_Fee: formFields.totalFee,
  Amount_Paid: formFields.amountPaid,

  Payment_Status:
    paymentMethod === "Course Hold"
      ? "Hold"
      : paymentMethod === "Single Shot"
      ? "Completed"
      : "Partial",

  Course_Name: formFields.courseName,
  Course_Type: formFields.courseType,
  Lecture_Language: formFields.lectureLanguage,
  Course_Start_Date: formFields.courseStartDate,

  Country: formFields.country,
  Complete_Address: formFields.address,

  Lead_Source: lead.Lead_Source,
  Service_Interested_In: lead.Service_Interested_In,

  PIB_LEAD_ID: lead.PIB_LEAD_ID
};


if (!dealData.data || dealData.data.length === 0) {

  console.log("🟢 Creating Deal");

  await fetch("https://www.zohoapis.in/crm/v2/Deals", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: [dealPayload] })
  });

} else {

  console.log("🟡 Updating Deal");

  const dealId = dealData.data[0].id;

  await fetch(`https://www.zohoapis.in/crm/v2/Deals/${dealId}`, {
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: [dealPayload] })
  });
}

return res.status(200).json({
  success: true,
  message: "Enrollment successful"
});

} catch (err) {
console.error("🔥 ERROR:", err);
return res.status(500).json({ error: err.message });
}
}