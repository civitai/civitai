import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createGenerationRequestSchema,
  getGenerationRequestsSchema,
} from '~/server/schema/generation.schema';
import {
  createGenerationRequest,
  deleteGenerationRequest,
  getGenerationRequests,
} from '~/server/services/generation/generation.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

// export default AuthedEndpoint(
//   async function handler(req, res, user) {
//     try {
//       switch (req.method) {
//         case 'DELETE':
//           const deleteInput = getByIdSchema.parse(req.query);
//           await deleteGenerationRequest({ ...deleteInput, userId: user.id });
//           return res.status(200);
//       }
//     } catch (e: any) {
//       res.status(400).send({ message: e.message });
//     }
//   },
//   ['DELETE']
// );
