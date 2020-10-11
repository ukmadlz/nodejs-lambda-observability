'use strict';

const AWS = require('aws-sdk');
const Axios = require('axios').default;
const Sharp = require('sharp');
const winston = require('winston');
const LogzioWinstonTransport = require('winston-logzio');
const Package = require('./package.json');

const axios = Axios.create({
  baseURL: 'https://api.giphy.com'
})

// Logger
const logzioWinstonTransport = new LogzioWinstonTransport({
  name: 'winston_logzio',
  type: `${Package.name}-${Package.version}`,
  token: process.env.ACCOUNT_TOKEN,
  host: `${process.env.LISTENER}:5015`,
  level: 'info'
});
const logger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      level: 'debug',
    }),
    logzioWinstonTransport,
  ]
});

const S3 = new AWS.S3();

// Grab gifs and save
module.exports.hello = async event => {
  try {
    logger.info('Get GIFs from Giphy Trending API');
    const giphyResponse = await axios.get('/v1/gifs/trending', {
      params: {
        api_key: process.env.GIPHY_API,
        limit: process.env.NUMBER_OF_GIFS || 25,
        rating: 'g'
      },
      responseType: 'json'
    });

    const gifs = giphyResponse.data.data
      .filter((gif) => {
        return gif.type === 'gif';
      })
      .map((gif) => {
        return gif.images.original.url;
      });
    logger.info({
      gifsFound: gifs.length,
      gifs,
    });

    logger.info('Get GIF content from Giphy');
    const gifContent = await Promise.all(gifs.map(async gif => {
      const gifName = Buffer.from(gif).toString('base64') + '.gif';
      logger.debug({ gifName });
      const gifData = await Axios({
        url: gif,
        method: 'get',
        responseType: 'arraybuffer',
      });
      try {
        logger.info('Save to S3 ' + gifName)
        return await S3.putObject({
          Bucket: process.env.BUCKET,
          Key: 'original/' + gifName,
          Body: gifData.data,
        }).promise();
      } catch (error) {
        logger.error(error);
        return false;
      }
    }));

    logger.info('Succesfully saved GIFs');
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: 'Gifs Saved',
          input: gifContent,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error({
      message: error.message,
      stack: error.stack,
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Failed to get from Giphy',
        error,
      },
      null,
      2,
      ),
    }
  }
};

// Create static thumbnails
module.exports.postprocess = async event => {
  try {
    return await Promise.all(event.Records.map(async record => {
      try {
        const originalFilename = record.s3.object.key;
        const Bucket = process.env.BUCKET;
        logger.info({
          task: 'resizing',
          image: originalFilename,
        });

        logger.debug({
          task: 'Get original from S3',
          originalFilename
        });
        const original = await S3.getObject({
          Bucket,
          Key: originalFilename,
        }).promise();

        logger.debug({
          task: 'Resize Original to Thumbnail',
        });
        const thumbnail = await Sharp(original.Body)
          .resize(100)
          .toBuffer();
        logger.debug({
          resized: originalFilename,
          thumbnail,
        });

        const thumbnailFilename = originalFilename.replace('original', 'thumbnail');
        logger.debug({
          task: 'send thumbnail to S3',
          image: thumbnailFilename,
        });
        return await S3.putObject({
          Bucket,
          Key: thumbnailFilename,
          Body: thumbnail,
        }).promise();
      } catch (error) {
        logger.error({
          message: error.message,
          stack: error.stack,
        });
        return error;
      }
    }));
  } catch (error) {
    logger.error({
      message: error.message,
      stack: error.stack,
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Failed to resize thumbnails',
        error,
      },
      null,
      2,
      ),
    }
  }
}
