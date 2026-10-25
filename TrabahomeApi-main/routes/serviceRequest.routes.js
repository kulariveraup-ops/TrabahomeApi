import express from "express";
import {
  createServiceRequest,
  deleteServiceRequest,
  getServiceRequestMessages,
  listAdminServiceRequests,
  getServiceRequestById,
  getServiceRequestProofOfPaymentAccessUrls,
  listHomeownerServiceRequests,
  listWorkerServiceRequests,
  postServiceRequestMessage,
  submitServiceRequestReview,
  submitWorkerServiceRequestReview,
  updateServiceRequest,
  proposeWorkerReschedule,
  respondHomeownerReschedule,
} from "../controllers/serviceRequests.controller.js";
import { requireAdminAuth } from "../middleware/authAdmin.js";
import { requireHomeownerAuth } from "../middleware/authHomeowner.js";
import { requireWorkerAuth } from "../middleware/authWorker.js";

const homeownerRouter = express.Router();
homeownerRouter.post("/service-requests", requireHomeownerAuth, createServiceRequest);
homeownerRouter.get("/service-requests", requireHomeownerAuth, listHomeownerServiceRequests);
homeownerRouter.get("/service-requests/:id", requireHomeownerAuth, getServiceRequestById);
homeownerRouter.get("/service-requests/:id/proof-of-payment/access-urls", requireHomeownerAuth, getServiceRequestProofOfPaymentAccessUrls);
homeownerRouter.patch("/service-requests/:id", requireHomeownerAuth, updateServiceRequest);
homeownerRouter.delete("/service-requests/:id", requireHomeownerAuth, deleteServiceRequest);
homeownerRouter.patch("/service-requests/:id/reschedule-response", requireHomeownerAuth, respondHomeownerReschedule);
homeownerRouter.post("/service-requests/:id/review", requireHomeownerAuth, submitServiceRequestReview);
homeownerRouter.get("/service-requests/:id/messages", requireHomeownerAuth, getServiceRequestMessages);
homeownerRouter.post("/service-requests/:id/messages", requireHomeownerAuth, postServiceRequestMessage);

const workerRouter = express.Router();
workerRouter.get("/service-requests", requireWorkerAuth, listWorkerServiceRequests);
workerRouter.get("/service-requests/:id", requireWorkerAuth, getServiceRequestById);
workerRouter.get("/service-requests/:id/proof-of-payment/access-urls", requireWorkerAuth, getServiceRequestProofOfPaymentAccessUrls);
workerRouter.patch("/service-requests/:id", requireWorkerAuth, updateServiceRequest);
workerRouter.patch("/service-requests/:id/reschedule", requireWorkerAuth, proposeWorkerReschedule);
workerRouter.post("/service-requests/:id/review", requireWorkerAuth, submitWorkerServiceRequestReview);
workerRouter.get("/service-requests/:id/messages", requireWorkerAuth, getServiceRequestMessages);
workerRouter.post("/service-requests/:id/messages", requireWorkerAuth, postServiceRequestMessage);

const adminRouter = express.Router();
adminRouter.get("/service-requests", requireAdminAuth, listAdminServiceRequests);
adminRouter.get("/service-requests/:id", requireAdminAuth, getServiceRequestById);
adminRouter.get("/service-requests/:id/proof-of-payment/access-urls", requireAdminAuth, getServiceRequestProofOfPaymentAccessUrls);
adminRouter.patch("/service-requests/:id", requireAdminAuth, updateServiceRequest);
adminRouter.get("/service-requests/:id/messages", requireAdminAuth, getServiceRequestMessages);
adminRouter.post("/service-requests/:id/messages", requireAdminAuth, postServiceRequestMessage);

export { homeownerRouter, workerRouter, adminRouter };
