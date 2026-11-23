import express from "express"
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from "stripe";
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(serverDirectory, ".env") });
const app = express();
const port = process.env.PORT || 5000;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;



// middleware
app.use(cors());


const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-mmcgsdf-shard-00-00.m4xd1qi.mongodb.net:27017,ac-mmcgsdf-shard-00-01.m4xd1qi.mongodb.net:27017,ac-mmcgsdf-shard-00-02.m4xd1qi.mongodb.net:27017/?ssl=true&replicaSet=atlas-wbfsly-shard-0&authSource=admin`);

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("wedora");

const services = database.collection("services")
const bookings = database.collection("bookings")
const transactions = database.collection("transactions")
const users = database.collection("user")

app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  const signature = req.headers["stripe-signature"]

  if (!stripe || !webhookSecret) {
    return res.status(503).json({ message: "Stripe webhook is not configured." })
  }
  if (typeof signature !== "string") {
    return res.status(400).json({ message: "Missing Stripe signature." })
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret)
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message)
    return res.status(400).json({ message: "Invalid Stripe signature." })
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object
      if (session.payment_status !== "paid") {
        return res.json({ received: true })
      }

      const vendorId = session.metadata?.vendorId
      if (
        session.mode !== "payment" ||
        session.status !== "complete" ||
        session.amount_total !== 2900 ||
        session.currency !== "usd" ||
        session.client_reference_id !== vendorId ||
        session.metadata?.plan !== "premium" ||
        session.metadata?.amountCents !== "2900" ||
        typeof vendorId !== "string"
      ) {
        return res.status(400).json({ message: "Checkout session details did not match." })
      }

      const transaction = await transactions.findOne({
        stripeSessionId: session.id,
        vendorId,
        plan: "premium",
        amount: 29,
        currency: "usd",
      })
      if (!transaction) {
        return res.status(500).json({ message: "Checkout transaction was not found." })
      }
      if (transaction.status !== "pending" && transaction.status !== "paid") {
        return res.json({ received: true })
      }

      await transactions.updateOne(
        { _id: transaction._id, status: "pending" },
        { $set: { status: "paid" } }
      )
      await activateVendorPremium(vendorId)
    } else if (event.type === "checkout.session.expired") {
      const session = event.data.object
      await transactions.updateOne(
        { stripeSessionId: session.id, status: "pending" },
        { $set: { status: "expired" } }
      )
    } else if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object
      await transactions.updateOne(
        { stripeSessionId: session.id, status: "pending" },
        { $set: { status: "failed" } }
      )
    }

    res.json({ received: true })
  } catch (err) {
    console.error(`Stripe webhook ${event.type} failed:`, err)
    res.status(500).json({ message: "Could not process Stripe event." })
  }
})

app.use(express.json())

async function vendorCanActivateService(vendorId, serviceId) {
  const vendor = await users.findOne({ _id: vendorId, role: "vendor" }, { projection: { subscriptionPlan: 1 } });
  if (vendor?.subscriptionPlan === "premium") return true;
  const filter = { vendorId, status: "approved", availability: "active" };
  if (serviceId) filter._id = { $ne: new ObjectId(serviceId) };
  return (await services.countDocuments(filter)) < 3;
}

async function activateVendorPremium(vendorId) {
  await users.updateOne(
    { _id: vendorId, role: "vendor" },
    {
      $set: { subscriptionPlan: "premium", subscriptionExpiresAt: null },
      $unset: { stripeSubscriptionId: "", subscriptionCancelAtPeriodEnd: "" },
    }
  );
}

function getAuthServerUrl() {
  return (process.env.BETTER_AUTH_URL || process.env.APP_URL || process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
}

function authSessionHeaders(token) {
  return { Cookie: `better-auth.session_token=${token}; __Secure-better-auth.session_token=${token}` };
}

function getAppUrl() {
  const url = process.env.APP_URL || process.env.CLIENT_URL;
  if (!url) throw new Error("APP_URL must be configured for Stripe Checkout.");
  return url.replace(/\/$/, "");
}

// --- Auth middleware ---
// Validates Bearer token via Better Auth session endpoint on the Next.js app
async function verifyVendorJwt(req, res, next) {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Missing auth token." });

    const sessionRes = await fetch(`${getAuthServerUrl()}/api/auth/get-session`, {
      headers: authSessionHeaders(token),
    });
    if (!sessionRes.ok) return res.status(401).json({ message: "Invalid session." });

    const sessionData = await sessionRes.json();
    const user = sessionData?.user;
    if (!user || user.role !== "vendor") {
      return res.status(403).json({ message: "Access denied: vendors only." });
    }
    const storedUser = await users.findOne({ _id: user.id });
    if (storedUser?.isBlocked) return res.status(403).json({ message: "This account is blocked." });

    req.vendorId = user.id;
    req.vendorUser = { ...user, ...storedUser, id: user.id };
    next();
  } catch (err) {
    console.error("verifyVendorJwt error:", err);
    res.status(500).json({ message: "Auth check failed." });
  }
}

async function verifyCustomerJwt(req, res, next) {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Missing auth token." });

    const sessionRes = await fetch(`${getAuthServerUrl()}/api/auth/get-session`, {
      headers: authSessionHeaders(token),
    });
    if (!sessionRes.ok) return res.status(401).json({ message: "Invalid session." });

    const sessionData = await sessionRes.json();
    const user = sessionData?.user;
    if (!user || user.role !== "customer") {
      return res.status(403).json({ message: "Access denied: customers only." });
    }
    const storedUser = await users.findOne({ _id: user.id }, { projection: { isBlocked: 1 } });
    if (storedUser?.isBlocked) return res.status(403).json({ message: "This account is blocked." });

    req.customerId = user.id;
    req.customerUser = user;
    next();
  } catch (err) {
    console.error("verifyCustomerJwt error:", err);
    res.status(500).json({ message: "Auth check failed." });
  }
}

async function verifyAdminJwt(req, res, next) {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Missing auth token." });

    const sessionRes = await fetch(`${getAuthServerUrl()}/api/auth/get-session`, {
      headers: authSessionHeaders(token),
    });
    if (!sessionRes.ok) return res.status(401).json({ message: "Invalid session." });
    const sessionData = await sessionRes.json();
    const user = sessionData?.user;
    if (!user || user.role !== "admin") return res.status(403).json({ message: "Access denied: admins only." });
    const storedUser = await users.findOne({ _id: user.id }, { projection: { isBlocked: 1 } });
    if (storedUser?.isBlocked) return res.status(403).json({ message: "This account is blocked." });
    req.adminId = user.id;
    next();
  } catch (err) {
    console.error("verifyAdminJwt error:", err);
    res.status(500).json({ message: "Auth check failed." });
  }
}

app.get('/', (req, res) => {
  res.send('Wedora is open');
});

app.get("/services", async (req, res) => {
  try {
    const { q, category, location, sort } = req.query;

    const filter = {
      status: "approved",
      availability: "active",
    };

    if (typeof q === "string" && q.trim()) {
      filter.serviceName = {
        $regex: q.trim(),
        $options: "i",
      };
    }

    if (typeof category === "string" && category.trim()) {
      filter.category = category.trim();
    }

    if (typeof location === "string" && location.trim()) {
      filter.location = {
        $regex: `^${location.trim()}$`,
        $options: "i",
      };
    }

    const sortOptions =
      sort === "price-asc"
        ? { price: 1 }
        : sort === "price-desc"
          ? { price: -1 }
          : { createdAt: -1 };

    const documents = await services.find(filter).sort(sortOptions).toArray();

    const locations = await services.distinct("location", {
      status: "approved",
      availability: "active",
      location: { $type: "string", $ne: "" },
    });

    res.json({
      services: documents.map((service) => ({
        id: service._id.toString(),
        serviceName: service.serviceName || "Wedding Service",
        category: service.category || "Wedding Service",
        description: service.description || "",
        price: typeof service.price === "number" ? service.price : 0,
        location: service.location || "",
        images: Array.isArray(service.images) ? service.images : [],
        vendorName: service.vendorInfo?.name || "WedPlan Vendor",
      })),
      locations: locations.filter((item) => typeof item === "string").sort(),
      total: documents.length,
    });
  } catch (err) {
    console.error("Could not fetch services:", err);
    res.status(500).json({ message: "Could not load services." });
  }
});

app.get("/services/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid service ID." });
  }

  try {
    const service = await services.findOne({
      _id: new ObjectId(req.params.id),
      status: "approved",
      availability: "active",
    });

    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    res.json({
      id: service._id.toString(),
      serviceName: service.serviceName || "Wedding Service",
      category: service.category || "Wedding Service",
      description: service.description || "",
      price: typeof service.price === "number" ? service.price : 0,
      location: service.location || "",
      images: Array.isArray(service.images)
        ? service.images.filter((image) => typeof image === "string" && image.trim())
        : [],
      vendorId: service.vendorId || "",
      vendorName: service.vendorInfo?.name || "WedPlan Vendor",
      vendorImage: service.vendorInfo?.image || "",
    });
  } catch (err) {
    console.error("Could not fetch service details:", err);
    res.status(500).json({ message: "Could not load service details." });
  }
});

// ===================== VENDOR ROUTES =====================

// ===================== ADMIN ROUTES =====================
app.get("/admin/overview", verifyAdminJwt, async (_req, res) => {
  try {
    const [totalUsers, totalVendors, totalCustomers, totalServices, pendingServices, totalTransactions] = await Promise.all([
      users.countDocuments({}),
      users.countDocuments({ role: "vendor" }),
      users.countDocuments({ role: "customer" }),
      services.countDocuments({}),
      services.countDocuments({ status: "pending" }),
      transactions.countDocuments({}),
    ]);
    res.json({ totalUsers, totalVendors, totalCustomers, totalServices, pendingServices, totalTransactions });
  } catch (err) {
    console.error("GET /admin/overview:", err);
    res.status(500).json({ message: "Could not load admin overview." });
  }
});

app.get("/admin/users", verifyAdminJwt, async (req, res) => {
  try {
    const filter = {};
    if (["admin", "vendor", "customer"].includes(req.query.role)) filter.role = req.query.role;
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const search = req.query.q.trim().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      filter.$or = [{ name: { $regex: search, $options: "i" } }, { email: { $regex: search, $options: "i" } }];
    }
    const docs = await users.find(filter, { projection: { name: 1, email: 1, image: 1, role: 1, isBlocked: 1, createdAt: 1, businessName: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1, emailVerified: 1 } }).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(docs.map((user) => ({ id: user._id.toString(), name: user.name || "Unnamed user", email: user.email || "", image: user.image || "", role: user.role || "customer", isBlocked: Boolean(user.isBlocked), createdAt: user.createdAt || null, businessName: user.businessName || "", subscriptionPlan: user.subscriptionPlan || "", subscriptionExpiresAt: user.subscriptionExpiresAt || null, emailVerified: Boolean(user.emailVerified) })));
  } catch (err) {
    console.error("GET /admin/users:", err);
    res.status(500).json({ message: "Could not load users." });
  }
});

app.patch("/admin/users/:id/block", verifyAdminJwt, async (req, res) => {
  try {
    const { isBlocked } = req.body;
    if (typeof isBlocked !== "boolean") return res.status(400).json({ message: "isBlocked must be true or false." });
    const user = await users.findOne({ _id: req.params.id });
    if (!user) return res.status(404).json({ message: "User not found." });
    if (req.params.id === req.adminId) return res.status(400).json({ message: "You cannot block your own admin account." });
    const result = await users.updateOne({ _id: req.params.id }, { $set: { isBlocked } });
    res.json({ id: req.params.id, isBlocked: result.matchedCount > 0 && isBlocked });
  } catch (err) {
    console.error("PATCH /admin/users/:id/block:", err);
    res.status(500).json({ message: "Could not update user access." });
  }
});

app.get("/admin/services", verifyAdminJwt, async (req, res) => {
  try {
    const filter = {};
    if (["pending", "approved", "rejected"].includes(req.query.status)) filter.status = req.query.status;
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      filter.serviceName = { $regex: req.query.q.trim().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"), $options: "i" };
    }
    const docs = await services.find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(docs.map((service) => ({ id: service._id.toString(), vendorId: service.vendorId || "", vendorName: service.vendorInfo?.name || "WedPlan Vendor", serviceName: service.serviceName || "Wedding service", category: service.category || "", price: service.price || 0, location: service.location || "", images: service.images || [], status: service.status || "pending", availability: service.availability || "active", createdAt: service.createdAt || null })));
  } catch (err) {
    console.error("GET /admin/services:", err);
    res.status(500).json({ message: "Could not load services." });
  }
});

app.patch("/admin/services/:id", verifyAdminJwt, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid service ID." });
    const updates = {};
    if (req.body.status !== undefined) {
      if (!["pending", "approved", "rejected"].includes(req.body.status)) return res.status(400).json({ message: "Invalid service status." });
      updates.status = req.body.status;
    }
    if (req.body.availability !== undefined) {
      if (!["active", "inactive"].includes(req.body.availability)) return res.status(400).json({ message: "Invalid availability." });
      updates.availability = req.body.availability;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ message: "No valid service changes provided." });
    const currentService = await services.findOne({ _id: new ObjectId(req.params.id) });
    if (!currentService) return res.status(404).json({ message: "Service not found." });
    const willBeActive = (updates.availability || currentService.availability) === "active" && (updates.status || currentService.status) === "approved";
    if (willBeActive && (updates.availability === "active" || updates.status === "approved") && !(await vendorCanActivateService(currentService.vendorId, req.params.id))) {
      return res.status(403).json({ message: "Free vendors can publish up to 3 active services. Upgrade to Premium to publish more." });
    }
    const result = await services.findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: updates }, { returnDocument: "after" });
    if (!result) return res.status(404).json({ message: "Service not found." });
    res.json({ id: result._id.toString(), status: result.status, availability: result.availability });
  } catch (err) {
    console.error("PATCH /admin/services/:id:", err);
    res.status(500).json({ message: "Could not update service." });
  }
});

app.delete("/admin/services/:id", verifyAdminJwt, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid service ID." });
    const result = await services.deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).json({ message: "Service not found." });
    res.json({ message: "Service deleted." });
  } catch (err) {
    console.error("DELETE /admin/services/:id:", err);
    res.status(500).json({ message: "Could not delete service." });
  }
});

app.get("/admin/transactions", verifyAdminJwt, async (_req, res) => {
  try {
    const docs = await transactions.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    const vendorIds = [...new Set(docs.map((transaction) => transaction.vendorId).filter(Boolean))];
    const vendorDocs = await users.find({ _id: { $in: vendorIds } }, { projection: { name: 1, email: 1, businessName: 1 } }).toArray();
    const vendorsById = new Map(vendorDocs.map((vendor) => [vendor._id.toString(), vendor]));
    res.json(docs.map((transaction) => {
      const vendor = vendorsById.get(String(transaction.vendorId));
      return { id: transaction._id.toString(), vendorId: String(transaction.vendorId || ""), vendorName: vendor?.businessName || vendor?.name || "Unknown vendor", vendorEmail: vendor?.email || "", plan: transaction.plan || "", amount: transaction.amount || 0, currency: transaction.currency || "USD", status: transaction.status || "pending", createdAt: transaction.createdAt || null };
    }));
  } catch (err) {
    console.error("GET /admin/transactions:", err);
    res.status(500).json({ message: "Could not load transactions." });
  }
});
// =================== END ADMIN ROUTES ===================

// Customers can only see bookings that belong to their authenticated account.
app.post("/customer/bookings", verifyCustomerJwt, async (req, res) => {
  try {
    const { serviceId, eventDate, eventLocation, message = "" } = req.body;
    if (!ObjectId.isValid(serviceId)) return res.status(400).json({ message: "Invalid service ID." });
    if (typeof eventDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ message: "Event date must be a valid date in YYYY-MM-DD format." });
    }
    const [year, month, day] = eventDate.split("-").map(Number);
    const parsedEventDate = new Date(Date.UTC(year, month - 1, day));
    if (
      parsedEventDate.getUTCFullYear() !== year ||
      parsedEventDate.getUTCMonth() !== month - 1 ||
      parsedEventDate.getUTCDate() !== day
    ) {
      return res.status(400).json({ message: "Event date is not a valid calendar date." });
    }
    const todayInDhaka = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    if (eventDate < todayInDhaka) {
      return res.status(400).json({ message: "Event date cannot be in the past." });
    }
    if (typeof eventLocation !== "string" || !eventLocation.trim()) {
      return res.status(400).json({ message: "Event date and location are required." });
    }
    if (eventLocation.trim().length > 160) {
      return res.status(400).json({ message: "Event location must be 160 characters or fewer." });
    }
    if (typeof message !== "string" || message.length > 1000) {
      return res.status(400).json({ message: "Message must be 1000 characters or fewer." });
    }
    const service = await services.findOne({
      _id: new ObjectId(serviceId), status: "approved", availability: "active",
    });
    if (!service) return res.status(404).json({ message: "This service is not available for booking." });
    if (service.vendorId === req.customerId) return res.status(403).json({ message: "You cannot book your own service." });

    const existingRequest = await bookings.findOne({
      serviceId: service._id.toString(), eventDate,
      status: { $in: ["pending", "accepted"] },
    });
    if (existingRequest) return res.status(409).json({ message: "This service already has an active booking request for that event date." });

    const booking = {
      serviceId: service._id.toString(),
      vendorId: service.vendorId,
      customerId: req.customerId,
      customerInfo: { name: req.customerUser.name || "WedPlan Customer", email: req.customerUser.email || "" },
      serviceInfo: { name: service.serviceName, serviceName: service.serviceName, images: service.images || [] },
      vendorInfo: service.vendorInfo || { name: "WedPlan Vendor", image: "" },
      eventDate,
      eventLocation: eventLocation.trim(),
      message: typeof message === "string" ? message.trim() : "",
      status: "pending",
      createdAt: new Date(),
    };
    const result = await bookings.insertOne(booking);
    res.status(201).json({ ...booking, _id: result.insertedId, id: result.insertedId.toString() });
  } catch (err) {
    console.error("POST /customer/bookings:", err);
    res.status(500).json({ message: "Could not submit booking request." });
  }
});

app.get("/customer/bookings", verifyCustomerJwt, async (req, res) => {
  try {
    const docs = await bookings.find({ customerId: req.customerId }).sort({ createdAt: -1 }).toArray();
    res.json(docs);
  } catch (err) {
    console.error("GET /customer/bookings:", err);
    res.status(500).json({ message: "Could not fetch bookings." });
  }
});

app.get("/customer/overview", verifyCustomerJwt, async (req, res) => {
  try {
    const [totalBookings, pendingBookings, acceptedBookings, rejectedBookings] = await Promise.all([
      bookings.countDocuments({ customerId: req.customerId }),
      bookings.countDocuments({ customerId: req.customerId, status: "pending" }),
      bookings.countDocuments({ customerId: req.customerId, status: "accepted" }),
      bookings.countDocuments({ customerId: req.customerId, status: "rejected" }),
    ]);
    res.json({ totalBookings, pendingBookings, acceptedBookings, rejectedBookings });
  } catch (err) {
    console.error("GET /customer/overview:", err);
    res.status(500).json({ message: "Could not load overview." });
  }
});

app.patch("/customer/bookings/:id/cancel", verifyCustomerJwt, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid booking ID." });
    }
    const result = await bookings.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), customerId: req.customerId, status: "pending" },
      { $set: { status: "cancelled" } },
      { returnDocument: "after" }
    );
    if (!result) {
      const booking = await bookings.findOne({ _id: new ObjectId(req.params.id) });
      if (!booking) return res.status(404).json({ message: "Booking not found." });
      if (booking.customerId !== req.customerId) return res.status(403).json({ message: "Access denied." });
      return res.status(400).json({ message: "Only pending bookings can be cancelled." });
    }
    res.json(result);
  } catch (err) {
    console.error("PATCH /customer/bookings/:id/cancel:", err);
    res.status(500).json({ message: "Could not cancel booking." });
  }
});

// POST /vendor/services — create a new service listing
app.post("/vendor/services", verifyVendorJwt, async (req, res) => {
  try {
    const { serviceName, category, description, price, location, images } = req.body;

    // Validate required fields
    if (!serviceName || !category || !description || !price || !location) {
      return res.status(400).json({ message: "Missing required fields: serviceName, category, description, price, location." });
    }

    // Free plan: max 3 active+approved services
    const activeCount = await services.countDocuments({
      vendorId: req.vendorId,
      status: "approved",
      availability: "active",
    });
    if (activeCount >= 3 && req.vendorUser.subscriptionPlan !== "premium") {
      return res.status(403).json({ message: "Free plan limit reached. Upgrade to premium to add more services." });
    }

    const doc = {
      vendorId: req.vendorId,
      vendorInfo: { name: req.vendorUser.name, image: req.vendorUser.image || "" },
      serviceName,
      category,
      description,
      price: Number(price),
      location,
      images: Array.isArray(images) ? images : [],
      status: "pending",
      availability: "active",
      createdAt: new Date(),
    };

    const result = await services.insertOne(doc);
    res.status(201).json({ ...doc, _id: result.insertedId, id: result.insertedId.toString() });
  } catch (err) {
    console.error("POST /vendor/services:", err);
    res.status(500).json({ message: "Could not create service." });
  }
});

// GET /vendor/services — list vendor's own services
app.get("/vendor/services", verifyVendorJwt, async (req, res) => {
  try {
    const docs = await services.find({ vendorId: req.vendorId }).sort({ createdAt: -1 }).toArray();
    res.json(docs.map((s) => ({ ...s, id: s._id.toString() })));
  } catch (err) {
    console.error("GET /vendor/services:", err);
    res.status(500).json({ message: "Could not fetch vendor services." });
  }
});

// PATCH /vendor/services/:id — update a vendor's service
app.patch("/vendor/services/:id", verifyVendorJwt, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid service ID." });
    }
    const oid = new ObjectId(req.params.id);

    const existing = await services.findOne({ _id: oid });
    if (!existing) return res.status(404).json({ message: "Service not found." });
    if (existing.vendorId !== req.vendorId) return res.status(403).json({ message: "Access denied." });

    // Only allow safe fields
    const { serviceName, category, description, price, location, images, availability } = req.body;
    const updates = {};
    if (serviceName !== undefined) updates.serviceName = serviceName;
    if (category !== undefined) updates.category = category;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = Number(price);
    if (location !== undefined) updates.location = location;
    if (images !== undefined) updates.images = images;
    if (availability !== undefined) updates.availability = availability;

    if (availability === "active" && existing.status === "approved" && !(await vendorCanActivateService(req.vendorId, req.params.id))) {
      return res.status(403).json({ message: "Free vendors can publish up to 3 active services. Upgrade to Premium to publish more." });
    }

    const result = await services.findOneAndUpdate(
      { _id: oid },
      { $set: updates },
      { returnDocument: "after" }
    );
    res.json({ ...result, id: result._id.toString() });
  } catch (err) {
    console.error("PATCH /vendor/services/:id:", err);
    res.status(500).json({ message: "Could not update service." });
  }
});

// DELETE /vendor/services/:id — remove a vendor's service
app.delete("/vendor/services/:id", verifyVendorJwt, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid service ID." });
    }
    const oid = new ObjectId(req.params.id);

    const existing = await services.findOne({ _id: oid });
    if (!existing) return res.status(404).json({ message: "Service not found." });
    if (existing.vendorId !== req.vendorId) return res.status(403).json({ message: "Access denied." });

    await services.deleteOne({ _id: oid });
    res.json({ message: "Service deleted successfully." });
  } catch (err) {
    console.error("DELETE /vendor/services/:id:", err);
    res.status(500).json({ message: "Could not delete service." });
  }
});

// GET /vendor/bookings — list all bookings for this vendor
app.get("/vendor/bookings", verifyVendorJwt, async (req, res) => {
  try {
    const docs = await bookings.find({ vendorId: req.vendorId }).sort({ createdAt: -1 }).toArray();
    res.json(docs);
  } catch (err) {
    console.error("GET /vendor/bookings:", err);
    res.status(500).json({ message: "Could not fetch bookings." });
  }
});

// PATCH /vendor/bookings/:id — accept or reject a pending booking
app.patch("/vendor/bookings/:id", verifyVendorJwt, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid booking ID." });
    }
    const oid = new ObjectId(req.params.id);
    const { action } = req.body;

    if (!["accept", "reject"].includes(action)) {
      return res.status(400).json({ message: "action must be 'accept' or 'reject'." });
    }

    const booking = await bookings.findOne({ _id: oid });
    if (!booking) return res.status(404).json({ message: "Booking not found." });
    if (booking.vendorId !== req.vendorId) return res.status(403).json({ message: "Access denied." });
    if (booking.status !== "pending") {
      return res.status(400).json({ message: "Can only act on pending bookings." });
    }

    const newStatus = action === "accept" ? "accepted" : "rejected";
    const result = await bookings.findOneAndUpdate(
      { _id: oid },
      { $set: { status: newStatus } },
      { returnDocument: "after" }
    );
    res.json(result);
  } catch (err) {
    console.error("PATCH /vendor/bookings/:id:", err);
    res.status(500).json({ message: "Could not update booking." });
  }
});

// GET /vendor/overview — dashboard stats
app.get("/vendor/overview", verifyVendorJwt, async (req, res) => {
  try {
    await transactions.updateMany(
      { vendorId: req.vendorId, status: "pending", createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      { $set: { status: "expired" } }
    );
    const vendorUser = req.vendorUser;
    const [totalServices, activeServices, pendingRequests, acceptedBookings] = await Promise.all([
      services.countDocuments({ vendorId: req.vendorId }),
      services.countDocuments({ vendorId: req.vendorId, availability: "active", status: "approved" }),
      bookings.countDocuments({ vendorId: req.vendorId, status: "pending" }),
      bookings.countDocuments({ vendorId: req.vendorId, status: "accepted" }),
    ]);

    res.json({
      totalServices,
      activeServices,
      pendingRequests,
      acceptedBookings,
      subscriptionPlan: vendorUser?.subscriptionPlan || "free",
    });
  } catch (err) {
    console.error("GET /vendor/overview:", err);
    res.status(500).json({ message: "Could not load overview." });
  }
});

// POST /vendor/subscription/checkout — create a Stripe test Checkout session.
app.post("/vendor/subscription/checkout", verifyVendorJwt, async (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
      return res.status(503).json({ message: "Configure a Stripe test secret key on the server." });
    }
    const { amountCents } = req.body;
    if (!Number.isInteger(amountCents) || amountCents !== 2900) {
      return res.status(400).json({ message: "Premium costs $29.00 USD as a one-time payment." });
    }
    if (req.vendorUser.subscriptionPlan === "premium") return res.status(400).json({ message: "This vendor already has Premium." });

    const appUrl = getAppUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: { name: "WedPlan Premium — Lifetime Access" },
        },
        quantity: 1,
      }],
      success_url: `${appUrl}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/dashboard/payment-cancel`,
      client_reference_id: req.vendorId,
      customer_email: req.vendorUser.email || undefined,
      metadata: { vendorId: req.vendorId, plan: "premium", amountCents: String(amountCents) },
    });

    await transactions.updateOne(
      { stripeSessionId: session.id },
      { $setOnInsert: {
        vendorId: req.vendorId,
        plan: "premium",
        amount: amountCents / 100,
        currency: "usd",
        stripeSessionId: session.id,
        status: "pending",
        createdAt: new Date(),
      } },
      { upsert: true }
    );
    res.json({ url: session.url });
  } catch (err) {
    console.error("POST /vendor/subscription/checkout:", err);
    res.status(500).json({ message: err.message || "Could not start Stripe Checkout." });
  }
});

// Confirm success directly with Stripe. The return URL itself never grants Premium.
app.post("/vendor/subscription/confirm", verifyVendorJwt, async (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) return res.status(503).json({ message: "Configure a Stripe test secret key on the server." });
    const { sessionId } = req.body;
    if (typeof sessionId !== "string" || !sessionId.startsWith("cs_")) {
      return res.status(400).json({ message: "A valid Checkout Session ID is required." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.client_reference_id !== req.vendorId || session.metadata?.vendorId !== req.vendorId) {
      return res.status(403).json({ message: "This Checkout Session belongs to another vendor." });
    }
    if (session.mode !== "payment" || session.status !== "complete" || session.payment_status !== "paid" || session.amount_total !== 2900 || session.currency !== "usd") {
      return res.status(400).json({ message: "Payment is not complete yet." });
    }
    const transaction = await transactions.findOne({ stripeSessionId: session.id, vendorId: req.vendorId });
    if (!transaction) return res.status(404).json({ message: "Checkout transaction was not found for this vendor." });

    await activateVendorPremium(req.vendorId);
    await transactions.updateOne(
      { stripeSessionId: session.id, vendorId: req.vendorId },
      { $set: {
        plan: "premium",
        amount: (session.amount_total || 0) / 100,
        currency: session.currency || "usd",
        status: "paid",
      } }
    );
    res.json({ message: "Your one-time payment is confirmed. Premium is active for your account.", subscriptionPlan: "premium" });
  } catch (err) {
    console.error("POST /vendor/subscription/confirm:", err);
    res.status(500).json({ message: "Could not verify the Stripe payment." });
  }
});

// ===================== END VENDOR ROUTES =====================

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Wedora is running on port ${port}`);
  });
}

export default app;
