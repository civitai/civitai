import { throwDbError } from '~/server/utils/errorHandling';
import { getAllPartners } from '~/server/services/partner.service';

export const getAllPartnersHandler = async () => {
  try {
    return await getAllPartners();
  } catch (error) {
    throw throwDbError(error);
  }
};
