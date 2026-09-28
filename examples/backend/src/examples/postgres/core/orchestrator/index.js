import Orchestrator from './orchestrator.js';

const orchestrator = new Orchestrator();

export default orchestrator;
export const productsService = orchestrator.productsService;
export const usersService = orchestrator.usersService;
