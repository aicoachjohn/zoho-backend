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

const pib_id_clean = pib_id
  .trim()
  .replace(/\s*-\s*/g, "-");

// ✅ ADDRESS BUILDER
const fullAddress = [
  formFields.address,
  formFields.city,
  formFields.state,
  formFields.pincode,
  formFields.addressCountry
].filter(Boolean).join(", ");


const leadRes = await fetch(
  `https://www.zohoapis.in/crm/v2/Leads/search?criteria=(PIB_LEAD_ID:equals:"${pib_id_clean}")`,
  { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
);

const leadData = await safeParse(leadRes, "LEAD SEARCH");

let lead = null;
let leadOwnerId = null;
let leadId = null; 

if (leadData.data && leadData.data.length > 0) {

  console.log("✅ Lead found in Leads");
  lead = leadData.data[0];
  leadOwnerId = lead.Owner.id;
  leadId = lead.id; 

} else {

  console.log("⚠️ Lead not in Leads, checking Contacts...");

  const contactResFallback = await fetch(
    `https://www.zohoapis.in/crm/v2/Contacts/search?criteria=(PIB_LEAD_ID:equals:"${pib_id_clean}")`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
  );

  const contactFallbackData = await safeParse(contactResFallback, "CONTACT SEARCH FALLBACK");

  if (!contactFallbackData.data || contactFallbackData.data.length === 0) {
    return res.status(404).json({ message: "Lead not found in Leads or Contacts" });
  }

  console.log("✅ Found in Contacts (converted lead)");

  const contact = contactFallbackData.data[0];

  // simulate lead object
  lead = contact;
  leadOwnerId = contact.Owner?.id;

  
}


// 🔹 UPDATE LEAD (only if leadId exists)
if (leadId) {
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
        Phone: formFields.mobile,

        Complete_Address: fullAddress,
        City_1: formFields.city,
        State_1: formFields.state,
        Country_1: formFields.addressCountry || formFields.country,
        Pincode: formFields.pincode,

        Course_Name: formFields.courseName,
        Course_Type: formFields.courseType,
        Lecture_Language: formFields.lectureLanguage,
        Course_Start_Date: formFields.courseStartDate,
        Enrollment_Status: "Enrollment Form Submitted"
      }]
    })
  });
}


// 🔹 CHECK / CREATE CONTACT
const contactRes = await fetch(
  `https://www.zohoapis.in/crm/v2/Contacts/search?criteria=(Email:equals:${encodeURIComponent(formFields.email)})`,
  { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
);

const contactData = await safeParse(contactRes, "CONTACT SEARCH");

let contactId = null;

if (!contactData.data || contactData.data.length === 0) {

  console.log("🟢 Creating Contact");

  const createContactRes = await fetch("https://www.zohoapis.in/crm/v2/Contacts", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      data: [{
        Owner: { id: leadOwnerId },
        Last_Name: formFields.fullName,
        Email: formFields.email,
        Phone: formFields.mobile,

        Complete_Address: fullAddress,
        City_1: formFields.city,
        State_1: formFields.state,
        Country_1: formFields.addressCountry || formFields.country,
        Pincode: formFields.pincode,

        Course_Name: formFields.courseName,
        Course_Type: formFields.courseType,
        Lecture_Language: formFields.lectureLanguage,
        Course_Start_Date: formFields.courseStartDate,

        Payment_Plan: formFields.paymentMethod,
        

        Lead_Source: lead.Lead_Source,
        Lead_Status: lead.Lead_Status,
        Service_Interested_In: lead.Service_Interested_In,
        PIB_LEAD_ID: lead.PIB_LEAD_ID 
      }]
    })
  });

  const newContact = await safeParse(createContactRes, "CREATE CONTACT");
  contactId = newContact.data?.[0]?.details?.id;

} else {

  console.log("🟡 Contact already exists");
  contactId = contactData.data[0].id;

  await fetch(`https://www.zohoapis.in/crm/v2/Contacts/${contactId}`, {
  method: "PUT",
  headers: {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    data: [{
      Owner: { id: leadOwnerId },
      Last_Name: formFields.fullName,
      Email: formFields.email,
      Phone: formFields.mobile,

      Complete_Address: fullAddress,
      City_1: formFields.city,
      State_1: formFields.state,
      Country_1: formFields.addressCountry || formFields.country,
      Pincode: formFields.pincode,

      // ✅ ADD THESE
      Course_Name: formFields.courseName,
      Course_Type: formFields.courseType,
      Lecture_Language: formFields.lectureLanguage,
      Course_Start_Date: formFields.courseStartDate,

      Payment_Plan: formFields.paymentMethod
    }]
  })
});
}


// 🔹 PAYMENT PLAN LOGIC
let pipeline = "";
let stage = "";

const paymentMethod = formFields.paymentMethod?.trim();
const paymentPlan = formFields.paymentPlan?.trim(); 

const method = paymentMethod?.toLowerCase();

if (method === "course hold") {
  pipeline = "Course Holding Pipeline";
  stage = "Hold Discussion";
}
else if (method === "single shot") {
  pipeline = "Single Shot Pipeline";
  stage = "Payment Completed";
}
else if (method === "installment") {
  pipeline = "Installments Pipeline";
  stage = "Initial Payment Done";
}


// 🔹 SEARCH DEAL (FIXED)
const dealRes = await fetch(
  `https://www.zohoapis.in/crm/v2/Deals/search?criteria=(PIB_LEAD_ID:equals:"${pib_id_clean}")`,
  { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
);

const dealData = await safeParse(dealRes, "DEAL SEARCH");


// 🔹 DEAL PAYLOAD
const dealPayload = {
  Deal_Name: formFields.fullName,
  Owner: { id: leadOwnerId },

  Contact_Name: { id: contactId },

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

  Complete_Address: fullAddress,
  City_1: formFields.city,
  State_1: formFields.state,
  Country_1: formFields.addressCountry || formFields.country,
  Pincode: formFields.pincode,

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