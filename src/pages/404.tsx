import { NextPage } from 'next';
import React from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';

const FourOhFour: NextPage = () => {
  return (
    <>
      <Meta title="Nothing found" deIndex="noindex" />
      <NotFound />
    </>
  );
};

export default FourOhFour;
