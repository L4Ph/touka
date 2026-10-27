import { deliveryWorker } from "./delivery";
import { deliveryHandlers } from "./plugins";

export class AdapterJobs extends deliveryWorker(deliveryHandlers()) {}
