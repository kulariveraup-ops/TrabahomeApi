import Skill from "../models/skill.Model.js";

export const DEFAULT_SKILLS = [
  { name: "Appliance Repair", category: "Home Repairs", startingPrice: 450, description: "Troubleshooting and repair for refrigerators, washers, and household appliances." },
  { name: "Babysitter", category: "Personal & Wellness", startingPrice: 350, description: "Childcare, supervision, and engaging activities." },
  { name: "Barber", category: "Personal & Wellness", startingPrice: 200, description: "Men's haircuts, styling, and grooming services." },
  { name: "Carpenter", category: "Home Repairs", startingPrice: 500, description: "Woodworking, cabinetry, framing, furniture fabrication, and door fitting." },
  { name: "Cook", category: "Events & Food", startingPrice: 400, description: "Home-cooked meal preparation and customized catering." },
  { name: "Electrician", category: "Home Repairs", startingPrice: 500, description: "Electrical wiring, lighting fixtures, circuit breakers, and power outlets." },
  { name: "Event Planner", category: "Events & Food", startingPrice: 1500, description: "Full-service coordination for birthdays, fiestas, weddings, and anniversaries." },
  { name: "Food Catering", category: "Events & Food", startingPrice: 2000, description: "Banquet buffet spreads, packed party trays, and celebration menus." },
  { name: "Gardener", category: "Cleaning & Yard", startingPrice: 350, description: "Lawn mowing, pruning, plant cultivation, and yard beautification." },
  { name: "Hair Stylist", category: "Personal & Wellness", startingPrice: 300, description: "Hair cutting, coloring, rebonding, and customized styling." },
  { name: "Handyman", category: "Home Repairs", startingPrice: 400, description: "General minor household repairs, fixture installations, and maintenance." },
  { name: "House Cleaning", category: "Cleaning & Yard", startingPrice: 350, description: "Deep cleaning, dusting, disinfection, and full-home sanitation." },
  { name: "Laundry", category: "Cleaning & Yard", startingPrice: 250, description: "Washing, fabric softening, folding, and garment ironing." },
  { name: "Locksmith", category: "Home Repairs", startingPrice: 450, description: "Deadbolt installation, lock picking, key duplication, and security latching." },
  { name: "Makeup Artist", category: "Personal & Wellness", startingPrice: 800, description: "Professional glam, traditional, and bridal hair and makeup." },
  { name: "Masonry", category: "Home Repairs", startingPrice: 550, description: "Concrete hollow block laying, plastering, stone tile setting, and brickwork." },
  { name: "Massage Therapist", category: "Personal & Wellness", startingPrice: 400, description: "Therapeutic whole-body massage, hilot, and relaxation services." },
  { name: "Painter", category: "Home Repairs", startingPrice: 450, description: "Interior and exterior wall coating, wood varnishing, and surface prep." },
  { name: "Pest Control", category: "Cleaning & Yard", startingPrice: 800, description: "Fumigation and barrier treatment for termites, ants, and pests." },
  { name: "Pet Grooming", category: "Personal & Wellness", startingPrice: 400, description: "Bathing, fur trimming, nail clipping, and ear cleaning for pets." },
  { name: "Photographer", category: "Events & Food", startingPrice: 1500, description: "Event coverage, portrait sessions, and high-resolution photo delivery." },
  { name: "Plumber", category: "Home Repairs", startingPrice: 450, description: "Leak fixing, PVC pipe laying, unclogging drains, and toilet repair." },
  { name: "Roofer", category: "Home Repairs", startingPrice: 600, description: "GI sheet patching, gutter realignment, waterproofing, and roof leak sealing." },
  { name: "Tailor", category: "Personal & Wellness", startingPrice: 300, description: "Clothing alterations, hemming, curtain sewing, and uniform stitching." },
  { name: "Welder", category: "Home Repairs", startingPrice: 550, description: "Metal gate fabrication, steel grill reinforcement, and spot welding." },
  { name: "Window Cleaner", category: "Cleaning & Yard", startingPrice: 300, description: "Exterior and interior glass panel washing, squeegee cleaning, and screen wiping." },
];

export const seedDefaultSkills = async () => {
  try {
    const count = await Skill.countDocuments();
    if (count === 0) {
      await Skill.insertMany(DEFAULT_SKILLS);
      console.log(`✅ Successfully seeded ${DEFAULT_SKILLS.length} default skills into database.`);
    }
  } catch (error) {
    console.error("Error seeding default skills:", error);
  }
};
