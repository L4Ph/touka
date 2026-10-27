import { deliveryWorker } from "./delivery";
import { deliveryHandlers } from "./plugins";

export class TriggerJobs extends deliveryWorker(deliveryHandlers()) {}
