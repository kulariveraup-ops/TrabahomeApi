import { Types } from "mongoose";
import ServiceRequest from "../models/serviceRequest.Model.js";
import Worker from "../models/worker.Model.js";

const normalizeWorkerIds = (workerIds) => [
  ...new Set(
    (Array.isArray(workerIds) ? workerIds : [workerIds])
      .map((value) => String(value?._id || value?.id || value || "").trim())
      .filter((value) => Types.ObjectId.isValid(value))
  ),
];

const emptyRatingStats = Object.freeze({ rating: 0, reviews: 0 });

export const isSubmittedWorkerReview = (request) => {
  const rating = Number(request?.reviewRating);
  return (
    String(request?.status || "").trim().toUpperCase() === "COMPLETED" &&
    Boolean(request?.reviewedAt) &&
    Number.isFinite(rating) &&
    rating >= 1 &&
    rating <= 5
  );
};

export const calculateWorkerRatingStats = (requests) => {
  const ratings = (Array.isArray(requests) ? requests : [])
    .filter(isSubmittedWorkerReview)
    .map((request) => Number(request.reviewRating));

  if (ratings.length === 0) return { ...emptyRatingStats };
  const average = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
  return {
    rating: Number(average.toFixed(2)),
    reviews: ratings.length,
  };
};

export const getWorkerRatingStats = async (workerIds) => {
  const normalizedIds = normalizeWorkerIds(workerIds);
  if (normalizedIds.length === 0) return new Map();

  const rows = await ServiceRequest.aggregate([
    {
      $match: {
        targetWorkerId: { $in: normalizedIds.map((id) => new Types.ObjectId(id)) },
        status: "COMPLETED",
        reviewedAt: { $ne: null },
        reviewRating: { $gte: 1, $lte: 5 },
      },
    },
    {
      $group: {
        _id: "$targetWorkerId",
        averageRating: { $avg: "$reviewRating" },
        reviewCount: { $sum: 1 },
      },
    },
  ]);

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        rating: Number(Number(row.averageRating || 0).toFixed(2)),
        reviews: Number(row.reviewCount || 0),
      },
    ])
  );
};

export const getWorkerRatingStatsForId = async (workerId) => {
  const normalizedId = normalizeWorkerIds([workerId])[0];
  if (!normalizedId) return { ...emptyRatingStats };
  const statsById = await getWorkerRatingStats([normalizedId]);
  return statsById.get(normalizedId) || { ...emptyRatingStats };
};

export const attachWorkerRatingStats = async (workers) => {
  const list = Array.isArray(workers) ? workers : [];
  const statsById = await getWorkerRatingStats(list);

  return list.map((worker) => {
    const id = String(worker?._id || worker?.id || "").trim();
    const stats = statsById.get(id) || emptyRatingStats;
    return { ...worker, rating: stats.rating, reviews: stats.reviews };
  });
};

export const refreshStoredWorkerRating = async (workerId) => {
  const normalizedId = normalizeWorkerIds([workerId])[0];
  if (!normalizedId) return { ...emptyRatingStats };

  const stats = await getWorkerRatingStatsForId(normalizedId);
  await Worker.findByIdAndUpdate(normalizedId, { rating: stats.rating });
  return stats;
};
