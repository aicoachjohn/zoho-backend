export default async function handler(req, res) {

res.setHeader("Access-Control-Allow-Origin", "https://enroll.proitbridge.com");
res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");

if (req.method === "OPTIONS") return res.status(200).end();
if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

// 🔹 LOG INCOMING PAYLOAD (helps diff desktop vs mobile)
console.log("📥 Incoming payload:", JSON.stringify(req.body, null, 2));
console.log("📥 User-Agent:", req.headers["user-agent"]);

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

// 🔹 WRAPPER: throws on HTTP error AND on per-record Zoho errors
async function zohoCall(url, options, label) {
  const response = await fetch(url, options);
  const data = await safeParse(response, label);

  if (!response.ok) {
    console.error(`❌ ${label} HTTP ${response.status}`, data);
    throw new Error(`${label} failed (HTTP ${response.status}): ${JSON.stringify(data)}`);
  }

  // Zoho returns HTTP 200 even when individual records fail.
  // Check per-record status inside data[0]
  if (Array.isArray(data.data) && data.data[0]?.status === "error") {
    console.error(`❌ ${label} record error`, data.data[0]);
    throw new Error(`${label} record error: ${data.data[0].message} | details: ${JSON.stringify(data.data[0].details)}`);
  }

  return data;
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
  await zohoCall(`https://www.zohoapis.in/crm/v2/Leads/${leadId}`, {
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      data: [{
        Salutation: formFields.salutation,
        First_Name: formFields.firstName,
        Last_Name: formFields.lastName || "NA",

        Complete_Address: formFields.address,
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
  }, "UPDATE LEAD");
}


// 🔹 PAYMENT PLAN LOGIC (moved up — needed by CONVERT LEAD below)
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


// 🔹 CONVERT LEAD → CONTACT + DEAL (only if we actually have a Lead)
if (leadId) {

  console.log("🔄 Converting Lead to Contact + Deal");

    const convertPayload = {
      data: [{
        overwrite: true,
        notify_lead_owner: false,
        notify_new_entity_owner: false,
        assign_to: leadOwnerId,
        Deals: {
          Deal_Name: formFields.fullName || `${formFields.firstName || ""} ${formFields.lastName || ""}`.trim() || "NA",
          Stage: stage,
          Pipeline: pipeline,
          Amount: formFields.totalFee,
          PIB_LEAD_ID: pib_id_clean
        }
      }]
    };

  await zohoCall(
    `https://www.zohoapis.in/crm/v2/Leads/${leadId}/actions/convert`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(convertPayload)
    },
    "CONVERT LEAD"
  );
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

  const newContact = await zohoCall("https://www.zohoapis.in/crm/v2/Contacts", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      data: [{
        Owner: { id: leadOwnerId },
        Salutation: formFields.salutation,
        First_Name: formFields.firstName,
        Last_Name: formFields.lastName || "NA",
        Email: formFields.email,
        Phone: formFields.mobile,

        Complete_Address: formFields.address,
        City_1: formFields.city,
        State_1: formFields.state,
        Country_1: formFields.addressCountry || formFields.country,
        Pincode: formFields.pincode,

        Course_Name: formFields.courseName,
        Course_Type: formFields.courseType,
        Lecture_Language: formFields.lectureLanguage,
        Course_Start_Date: formFields.courseStartDate,

        Payment_Plan: formFields.paymentMethod,
        GST_Treatment: formFields.gstTreatment,
        

        Lead_Source: lead.Lead_Source,
        Lead_Status: lead.Lead_Status,
        Service_Interested_In: lead.Service_Interested_In,
        PIB_LEAD_ID: lead.PIB_LEAD_ID 
      }]
    })
  }, "CREATE CONTACT");

  contactId = newContact.data?.[0]?.details?.id;

} else {

  console.log("🟡 Contact already exists");
  contactId = contactData.data[0].id;

  await zohoCall(`https://www.zohoapis.in/crm/v2/Contacts/${contactId}`, {
  method: "PUT",
  headers: {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    data: [{
      Owner: { id: leadOwnerId },
      Salutation: formFields.salutation,
      First_Name: formFields.firstName,
      Last_Name: formFields.lastName || "NA",
      

      Complete_Address: formFields.address,
      City_1: formFields.city,
      State_1: formFields.state,
      Country_1: formFields.addressCountry || formFields.country,
      Pincode: formFields.pincode,

      // ✅ ADD THESE
      Course_Name: formFields.courseName,
      Course_Type: formFields.courseType,
      Lecture_Language: formFields.lectureLanguage,
      Course_Start_Date: formFields.courseStartDate,

      GST_Treatment: formFields.gstTreatment,
      Payment_Plan: formFields.paymentMethod
    }]
  })
}, "UPDATE CONTACT");
}


// 🔹 SEARCH DEAL — by Contact + PIB_LEAD_ID (prevents hitting another person's deal)
const dealRes = await fetch(
  `https://www.zohoapis.in/crm/v2/Deals/search?criteria=((Contact_Name:equals:${contactId})and(PIB_LEAD_ID:equals:"${pib_id_clean}"))`,
  { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
);

const dealData = await safeParse(dealRes, "DEAL SEARCH");

// Extra safety: even if Zoho returns multiple, only keep deals that belong to THIS contact
let matchedDeal = null;
if (dealData.data && dealData.data.length > 0) {
  matchedDeal = dealData.data.find(d => {
    const linkedContactId = d.Contact_Name?.id || d.Contact_Name;
    return String(linkedContactId) === String(contactId);
  });
}


// 🔹 DEAL PAYLOAD
const dealPayload = {
  Deal_Name: formFields.fullName || `${formFields.firstName || ""} ${formFields.lastName || ""}`.trim() || "NA",
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

  Complete_Address: formFields.address,
  City_1: formFields.city,
  State_1: formFields.state,
  Country_1: formFields.addressCountry || formFields.country,
  Pincode: formFields.pincode,

  Lead_Source: lead.Lead_Source,
  Service_Interested_In: lead.Service_Interested_In,

  PIB_LEAD_ID: lead.PIB_LEAD_ID
};


if (!matchedDeal) {

  console.log("🟢 Creating Deal");

  await zohoCall("https://www.zohoapis.in/crm/v2/Deals", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: [dealPayload] })
  }, "CREATE DEAL");

} else {

  console.log("🟡 Updating Deal", matchedDeal.id);

  const dealId = matchedDeal.id;

  await zohoCall(`https://www.zohoapis.in/crm/v2/Deals/${dealId}`, {
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: [dealPayload] })
  }, "UPDATE DEAL");
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