import express from "express"
import cors from "cors";
import "dotenv/config";
import { MongoClient } from 'mongodb';
const app = express();
const port = process.env.PORT || 5000;



// middleware
app.use(express.json());
app.use(cors());


const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-mmcgsdf-shard-00-00.m4xd1qi.mongodb.net:27017,ac-mmcgsdf-shard-00-01.m4xd1qi.mongodb.net:27017,ac-mmcgsdf-shard-00-02.m4xd1qi.mongodb.net:27017/?ssl=true&replicaSet=atlas-wbfsly-shard-0&authSource=admin`
);

export async function connectToMongoDB() {
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
app.listen(port, () => {
  console.log(`Wedora is running on port ${port}`);
});