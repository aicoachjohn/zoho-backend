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

  async function zohoCall(url, options, label) {
    const response = await fetch(url, options);
    const data = await safeParse(response, label);

    if (!response.ok) {
      console.error(`❌ ${label} HTTP ${response.status}`, data);
      throw new Error(`${label} failed (HTTP ${response.status}): ${JSON.stringify(data)}`);
    }

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
          }],
          trigger: []   // 🔒 prevent workflows from firing & reassigning Owner
        })
      }, "UPDATE LEAD");
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
    } else if (method === "single shot") {
      pipeline = "Single Shot Pipeline";
      stage = "Payment Completed";
    } else if (method === "installment") {
      pipeline = "Installments Pipeline";
      stage = "Initial Payment Done";
    }


    // 🔹 CONVERT LEAD → CONTACT + DEAL (only if we actually have a Lead)
    let convertedContactId = null;
    let convertedDealId = null;

    if (leadId) {

      console.log("🔄 Converting Lead to Contact + Deal");

      // ✅ No assign_to / Owner — Zoho will inherit the current Lead Owner
      const convertPayload = {
        data: [{
          notify_lead_owner: true,
          notify_new_entity_owner: true,

          Deals: {
            Deal_Name: formFields.fullName || `${formFields.firstName || ""} ${formFields.lastName || ""}`.trim() || "NA",
            Stage: stage,
            Pipeline: pipeline,
            Amount: formFields.totalFee,
            PIB_LEAD_ID: pib_id_clean
          }
        }]
      };

      const convertRes = await zohoCall(
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

      const converted = convertRes.data?.[0] || {};
      convertedContactId = converted.Contacts;
      convertedDealId = converted.Deals;

      console.log("✅ Convert IDs:", { convertedContactId, convertedDealId });
    }


    // 🔹 RESOLVE CONTACT
    let contactId = null;

    if (convertedContactId) {
      console.log("🔗 Using contact from conversion:", convertedContactId);
      contactId = convertedContactId;

      await zohoCall(`https://www.zohoapis.in/crm/v2/Contacts/${contactId}`, {
        method: "PUT",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          data: [{
            // ✅ No Owner — conversion already set it correctly
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

            PIB_LEAD_ID: pib_id_clean
          }],
          trigger: []   // 🔒 prevent workflows from re-firing
        })
      }, "UPDATE CONVERTED CONTACT");

    } else {
      console.log("🔎 Searching existing Contact by PIB_LEAD_ID");

      const contactRes = await fetch(
        `https://www.zohoapis.in/crm/v2/Contacts/search?criteria=(PIB_LEAD_ID:equals:"${pib_id_clean}")`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
      );

      const contactData = await safeParse(contactRes, "CONTACT SEARCH BY PIB");

      if (contactData.data && contactData.data.length > 0) {
        console.log("🟡 Contact found, updating");
        contactId = contactData.data[0].id;

        await zohoCall(`https://www.zohoapis.in/crm/v2/Contacts/${contactId}`, {
          method: "PUT",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            data: [{
              // ✅ No Owner — keep whatever owner the Contact already has
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

              GST_Treatment: formFields.gstTreatment,
              Payment_Plan: formFields.paymentMethod,

              PIB_LEAD_ID: pib_id_clean
            }],
            trigger: []
          })
        }, "UPDATE CONTACT");

      } else {
        console.log("🟢 No contact found, creating new");

        const newContact = await zohoCall("https://www.zohoapis.in/crm/v2/Contacts", {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            data: [{
              Owner: { id: leadOwnerId },   // ✅ use live owner from Zoho, not form
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
            }],
            trigger: []
          })
        }, "CREATE CONTACT");

        contactId = newContact.data?.[0]?.details?.id;
      }
    }


    // 🔹 RESOLVE DEAL
    let matchedDeal = null;

    if (convertedDealId) {
      matchedDeal = { id: convertedDealId };
      console.log("🔗 Using Deal from conversion:", convertedDealId);
    } else {
      const dealRes = await fetch(
        `https://www.zohoapis.in/crm/v2/Deals/search?criteria=((Contact_Name:equals:${contactId})and(PIB_LEAD_ID:equals:"${pib_id_clean}"))`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
      );

      const dealData = await safeParse(dealRes, "DEAL SEARCH");

      if (dealData.data && dealData.data.length > 0) {
        matchedDeal = dealData.data.find(d => {
          const linkedContactId = d.Contact_Name?.id || d.Contact_Name;
          return String(linkedContactId) === String(contactId);
        });
      }
    }


    // 🔹 DEAL PAYLOAD
    // ✅ No Owner — keep whatever owner Zoho assigned during conversion
    const dealPayload = {
      Deal_Name: formFields.fullName || `${formFields.firstName || ""} ${formFields.lastName || ""}`.trim() || "NA",

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
        body: JSON.stringify({ data: [dealPayload], trigger: [] })
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
        body: JSON.stringify({ data: [dealPayload], trigger: [] })
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