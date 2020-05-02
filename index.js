const express = require('express')
const app = express()
const port = process.env.PORT || 8787
const bodyParser = require('body-parser')
const morgan = require('morgan')
const bcrypt = require('bcrypt');
const moment = require('moment')
const { nanoid } = require('nanoid')
const { parseText } = require('./helpers/parseText')

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  next();
});

app.use(bodyParser())

const configDatabase = require('./database.js')
const mongoose = require('mongoose')
mongoose.connect(configDatabase.url, { useNewUrlParser: true })
const User = require('./models/user')
const Relationship = require('./models/relationship')
const Post = require('./models/post')
require('./models/tag')
const Community = require('./models/community')
require('./models/vote')
const Image = require('./models/image')

const sendError = (status, message) => {
  return {
    error: {
      message: message,
      status: status
    }
  }
}

const sendResponse = (data, status, message) => {
  return {
    data: data,
    message: message,
    status: status
  }
}

function touchCommunity (id) {
  Community.findOneAndUpdate({
    _id: id
  }, {
    $set: {
      lastUpdated: new Date()
    }
  }).then(community => {
    console.log('Updated community!')
  })
}

app.post('/api/login', function (req, res) {
  // Check if anything has been submitted
  if (!req.body.email || !req.body.password) {
    return res.status(401).send(sendError(401, "User not authenticated"))
  }
  User.findOne({ email: req.body.email })
    .then(user => {
      // If no user found
      if (!user) {
        return res.status(401).send(sendError(401, "User not authenticated"))
      }
      // Compare submitted password to database hash
      bcrypt.compare(req.body.password, user.password, function (err, result) {
        if (result) {
          return res.status(200).send(sendResponse(user, 200))
        } else {
          return res.status(401).send(sendError(401, "User not authenticated"))
        }
      });
    })
    .catch(error => {
      console.error(error)
      return res.status(401).send(sendError(401, "User not authenticated"))
    })
})

app.get('/api/post/:postid', async (req, res) => {

})

app.get('/api/posts/:context?/:timestamp?/:identifier?', async (req, res) => {
  const timestamp = req.params.timestamp ? new Date(parseInt(req.params.timestamp)) : Date.now()
  console.log(timestamp)
  const postsPerPage = 20
  const userId = req.header('Authorization');
  const user = (await User.findOne({ _id: userId }))
  const myFollowedUserIds = ((await Relationship.find({ from: user.email, value: 'follow' })).map(v => v.toUser)).concat([user._id])
  const myFlaggedUserEmails = ((await Relationship.find({ from: user.email, value: 'flag' })).map(v => v.to))
  const myMutedUserEmails = ((await Relationship.find({ from: user.email, value: 'mute' })).map(v => v.to))
  const myTrustedUserEmails = ((await Relationship.find({ from: user.email, value: 'trust' })).map(v => v.to))
  const usersFlaggedByMyTrustedUsers = ((await Relationship.find({ from: { $in: myTrustedUserEmails }, value: 'flag' })).map(v => v.to))
  const usersWhoTrustMeEmails = ((await Relationship.find({ to: user.email, value: 'trust' })).map(v => v.from)).concat([user.email])
  const myCommunities = user.communities
  if (req.params.context === 'community') {
    isMuted = (await Community.findById(req.params.identifier)).mutedMembers.some(v => v.equals(user._id))
  } else {
    isMuted = false
  }
  flagged = usersFlaggedByMyTrustedUsers.concat(myFlaggedUserEmails).filter(e => e !== user.email)

  let matchPosts
  let sortMethod = '-lastUpdated'
  let thisComm
  switch (req.params.context) {
    case 'home':
      // on the home page, we're looking for posts (and boosts) created by users we follow as well as posts in communities that we're in.
      // we're assuming the user is logged in if this request is being made (it's only made by code on a page that only loads if the user is logged in.)
      matchPosts = {
        $or: [{
          author: {
            $in: myFollowedUserIds
          }
        },
        {
          type: 'community',
          community: {
            $in: myCommunities
          }
        }
        ],
        type: { $ne: 'draft' }
      }
      break;
    case 'user':
      // if we're on a user's page, obviously we want their posts:
      matchPosts = {
        author: req.params.identifier,
        type: { $ne: 'draft' }
      }
      // but we also only want posts if they're non-community or they come from a community that we belong to:
      matchPosts.$or = [{
        community: {
          $exists: false
        }
      }, {
        community: {
          $in: myCommunities
        }
      }]
      break;
    case 'community':
      thisComm = await Community.findById(req.params.identifier)
      // we want posts from the community, but only if it's public or we belong to it:
      if (thisComm.settings.visibility === 'public' || myCommunities.some(v => v.toString() === req.params.identifier)) {
        matchPosts = {
          community: req.params.identifier
        }
      } else {
        // if we're not in the community and it's not public, there are no posts we're allowed to view!
        matchPosts = undefined
      }
      break;
    case 'tag':
      const getTag = () => {
        return Tag.findOne({ name: req.params.identifier })
          .then((tag) => {
            return { _id: { $in: tag.posts }, type: { $ne: 'draft' } }
          })
      }
      matchPosts = await getTag()
      break;
    case 'single':
      matchPosts = {
        _id: req.params.identifier,
        type: { $ne: 'draft' }
      }
  }

  matchPosts[sortMethod.substring(1, sortMethod.length)] = { $lt: timestamp }

  const query = Post
    .find(matchPosts)
    .sort(sortMethod)
    .limit(postsPerPage)
    // these populate commands retrieve the complete data for these things that are referenced in the post documents
    .populate('author', 'username imageEnabled image displayName')
    .populate('community', 'name slug url imageEnabled image mutedMembers')
    // If there's a better way to populate a nested tree lmk because this is... dumb. Mitch says: probably just fetching the authors recursively in actual code below
    .populate('comments.author', 'username imageEnabled image displayName')
    .populate('comments.replies.author', 'username imageEnabled image displayName')
    .populate('comments.replies.replies.author', 'username imageEnabled image displayName')
    .populate('comments.replies.replies.replies.author', 'username imageEnabled image displayName')
    .populate('comments.replies.replies.replies.replies.author', 'username imageEnabled image displayName')
    .populate('boostTarget')
    .populate('boostsV2.booster', 'username imageEnabled image displayName')

  // so this will be called when the query retrieves the posts we want
  const posts = await query

  if (!posts || !posts.length) {
    return res.status(404).send(sendError(404, 'No posts found'))
  }

  let displayedPost
  // this gets the timestamp of the last post, this tells the browser to ask for posts older than this next time. used in feeds, not with single posts
  // let oldesttimestamp = '' + posts[posts.length - 1][sortMethod.substring(1, sortMethod.length)].getTime()

  const displayedPosts = [] // populated by the for loop below

  for (const post of posts) {
    // figure out if there is a newer instance of the post we're looking at. if it's an original post, check the boosts from
    // the context's relevant users; if it's a boost, check the original post if we're in fluid mode to see if lastUpdated is more
    // recent (meaning the original was bumped up from recieving a comment) and then for both fluid and chronological we have to check
    // to see if there is a more recent boost.
    if (req.params.context !== 'community' && req.params.context !== 'single') {
      let isThereNewerInstance = false
      const whosePostsCount = req.params.context === 'user' ? [new ObjectId(req.params.identifier)] : myFollowedUserIds
      if (post.type === 'original') {
        for (const boost of post.boostsV2) {
          if (boost.timestamp.getTime() > post.lastUpdated.getTime() && whosePostsCount.some(f => boost.booster.equals(f))) {
            isThereNewerInstance = true
          }
        }
      } else if (post.type === 'boost') {
        if (post.boostTarget !== null) {
          if (sortMethod === '-lastUpdated') {
            if (post.boostTarget.lastUpdated.getTime() > post.timestamp.getTime()) {
              isThereNewerInstance = true
            }
          }
          for (const boost of post.boostTarget.boostsV2) {
            if (boost.timestamp.getTime() > post.lastUpdated.getTime() && whosePostsCount.some(f => boost.booster.equals(f))) {
              isThereNewerInstance = true
            }
          }
        } else {
          console.log('Error fetching boostTarget of boost')
          isThereNewerInstance = true
        }
      }

      if (isThereNewerInstance) {
        continue
      }
    }

    let canDisplay = false
    // logged in users can't see private posts by users who don't trust them or community posts by muted members
    if ((post.privacy === 'private' && usersWhoTrustMeEmails.includes(post.authorEmail)) || post.privacy === 'public') {
      canDisplay = true
    }
    if (post.type === 'community') {
      // we don't have to check if the user is in the community before displaying posts to them if we're on the community's page, or if it's a single post page and: the community is public or the user wrote the post
      // in other words, we do have to check if the user is in the community if those things aren't true, hence the !
      if (!(req.params.context === 'community' || (req.params.context === 'single' && (post.author.equals(user) || post.community.settings.visibility === 'public')))) {
        if (myCommunities.some(m => m.equals(post.community._id))) {
          canDisplay = true
        } else {
          canDisplay = false
        }
      }
      // Hide muted community members
      const mutedMemberIds = post.community.mutedMembers.map(a => a._id.toString())
      if (mutedMemberIds.includes(post.author._id.toString())) {
        canDisplay = false
      }
    }

    // As a final hurrah, just hide all posts and boosts made by users you've muted
    if (myMutedUserEmails.includes(post.authorEmail)) {
      canDisplay = false
    }

    if (!canDisplay) {
      continue
    }

    let displayContext = post
    if (post.type === 'boost') {
      displayContext = post.boostTarget
      displayContext.author = await User.findById(displayContext.author, 'username imageEnabled image displayName')
      for (const boost of displayContext.boostsV2) {
        boost.booster = await User.findById(boost.booster, 'username imageEnabled image displayName')
      }
    }

    // Used to check if you can delete a post
    let isYourPost = displayContext.author._id.equals(user)

    // generate some arrays containing usernames that will be put in "boosted by" labels
    let boostsForHeader
    let youBoosted
    const followedBoosters = []
    const notFollowingBoosters = []
    if (req.params.context !== 'community') {
      youBoosted = false
      if (displayContext.boostsV2.length > 0) {
        displayContext.boostsV2.forEach((v, i, a) => {
          if (!(v.timestamp.getTime() === displayContext.timestamp.getTime())) { // do not include implicit boost
            if (v.booster._id.equals(user)) {
              followedBoosters.push('you')
              youBoosted = true
            } else {
              if (myFollowedUserIds.some(following => { if (following) { return following.equals(v.booster._id) } })) {
                followedBoosters.push(v.booster.username)
              } else {
                notFollowingBoosters.push(v.booster.username)
              }
            }
          }
        })
      }
      if (req.params.context === 'user' && !displayContext.author._id.equals(post.author._id)) {
        boostsForHeader = [post.author.username]
      } else {
        boostsForHeader = followedBoosters.slice(0, 3)
      }
    } else {
      if (req.params.context === 'user') {
        if (displayContext.author._id.toString() !== req.params.identifier) {
          boostsForHeader = [(await (User.findById(req.params.identifier, 'username'))).username]
        }
      }
    }

    displayedPost = Object.assign(displayContext, {
      deleteid: displayContext._id,
      timestampMs: displayContext.timestamp.getTime(),
      editedTimestampMs: displayContext.lastEdited ? displayContext.lastEdited.getTime() : '',
      headerBoosters: boostsForHeader,
      havePlused: displayContext.pluses.filter(plus => plus.author.equals(user))
    })

    displayedPost.followedBoosters = followedBoosters
    displayedPost.otherBoosters = notFollowingBoosters
    displayedPost.isYourPost = isYourPost
    displayedPost.youBoosted = youBoosted

    // get timestamps and full image urls for each comment
    const parseComments = (element, level) => {
      if (!level) {
        level = 1
      }
      element.forEach(async (comment) => {
        comment.canDisplay = true
        comment.muted = false
        // I'm not sure why, but boosts in the home feed don't display
        // comment authors below the top level - this fixes it, but
        // it's kind of a hack - I can't work out what's going on
        if (!comment.author.username) {
          comment.author = await User.findById(comment.author, 'username imageEnabled image displayName')
        }
        if (myMutedUserEmails.includes(comment.author.email)) {
          comment.muted = true
          comment.canDisplay = false
        }
        if (comment.deleted) {
          comment.canDisplay = false
        }
        for (let i = 0; i < comment.images.length; i++) {
          comment.images[i] = '/api/image/display/' + comment.images[i]
        }
        // If the comment's author is logged in, or the displayContext's author is logged in
        if (((comment.author._id.equals(user)) || (displayContext.author._id.equals(user))) && !comment.deleted) {
          comment.canDelete = true
        }
        if (level < 5) {
          comment.canReply = true
        }
        comment.level = level
        if (comment.replies) {
          parseComments(comment.replies, level + 1)
        }
      })
    }
    parseComments(displayedPost.comments)

    // wow, finally.
    displayedPosts.push(displayedPost)
  }
  return res.status(200).send(sendResponse(displayedPosts, 200))
})

app.post('/api/plus/:postid', async (req, res) => {
  const userId = req.header('Authorization');
  console.log(userId)
  const user = (await User.findOne({ _id: userId }))
  let plusAction
  Post.findOne({
    _id: req.params.postid
  }, {
    url: 1,
    author: 1,
    pluses: 1,
    numberOfPluses: 1
  }).populate('author')
    .then((post) => {
      if (post.pluses.some(plus => plus.author.equals(user._id))) {
        // This post already has a plus from this user, so we're unplussing it
        post.pluses = post.pluses.filter(plus => !plus.author.equals(user._id))
        plusAction = 'remove'
      } else {
        post.pluses.push({ author: user._id, type: 'plus', timestamp: new Date() })
        plusAction = 'add'
      }
      post.numberOfPluses = post.pluses.length
      post.save().then((updatedPost) => {
        // Don't notify yourself if you plus your own posts, you weirdo
        if (plusAction === 'add' && !post.author._id.equals(user._id)) {
          // notifier.notify('user', 'plus', post.author._id, user._id, null, '/' + post.author.username + '/' + post.url, 'post');
        }
        return res.status(200).send(sendResponse({ pluses: post.pluses, plusAction: plusAction }, 200))
      })
    })
    .catch(error => {
      console.log(error)
      return res.status(500).send(sendError(500, 'Error fetching post to plus'))
    })
})

app.post('/api/post', async (req, res) => {
  console.log("New post", req.body)
  const userId = req.header('Authorization');
  const user = (await User.findOne({ _id: userId }))
  const postContent = req.body.content
  const contentWarning = req.body.contentWarning
  const isPrivate = req.body.isPrivate
  const isCommunityPost = req.body.isCommunityPost
  const isDraft = req.body.isDraft

  if (!user || !postContent) {
    return res.status(403).send(sendError(403, 'Post content empty or user not found'))
  }
  const parsedPayload = parseText(postContent)

  console.log(parsedPayload)

  const inlineElements = {
    type: 'image(s)',
    images: req.body.images,
    position: parsedPayload.array.length // At the end of the post
  }

  const newPostUrl = nanoid()
  const postCreationTime = new Date()

  const post = new Post({
    type: isCommunityPost ? 'community' : isDraft ? 'draft' : 'original',
    community: isCommunityPost ? req.body.communityId : undefined,
    authorEmail: user.email,
    author: user._id,
    url: newPostUrl,
    // Community posts are always public, drafts are always private, otherwise we check the privacy setting
    privacy: isCommunityPost ? 'public' : isDraft ? 'private' : isPrivate ? 'private' : 'public',
    timestamp: postCreationTime,
    lastUpdated: postCreationTime,
    rawContent: req.body.content,
    parsedContent: parsedPayload.text,
    numberOfComments: 0,
    mentions: parsedPayload.mentions,
    tags: parsedPayload.tags,
    contentWarnings: contentWarning,
    imageVersion: 3,
    inlineElements: req.body.images ? inlineElements : undefined,
    subscribedUsers: [user._id]
  })

  if (req.body.images) {
    req.body.images.forEach(async (filename) => {
      const image = new Image({
        context: isCommunityPost ? 'community' : 'user',
        filename: 'images/' + filename,
        url: 'https://sweet-images.s3.eu-west-2.amazonaws.com/images/' + filename,
        privacy: isPrivate ? 'private' : 'public',
        user: user._id,
        // quality: postImageQuality,
        // height: metadata.height,
        // width: metadata.width
      })
      await image.save()
    })
  }

  await post.save()
    .then((response) => {
      console.log("New post posted!")
      return res.status(200).send(sendResponse(response, 200))
    })
})

app.post('/api/comment/:postid/:commentid?', async (req, res) => {
  // loop over the array of comments adding 1 +  countComments on its replies to the count variable.
  function countComments(comments) {
    let count = 0
    for (const comment of comments) {
      if (!comment.deleted) {
        count += 1
        if (comment.replies.length) {
          count += countComments(comment.replies)
        }
      }
    }
    return count
  }

  function findCommentByID(id, comments, depth = 1) {
    for (const comment of comments) {
      if (comment._id.equals(id)) {
        return { commentParent: comment, depth }
      } else {
        if (comment.replies.length > 0) {
          const searchReplies = findCommentByID(id, comment.replies, depth + 1)
          if (searchReplies !== 0) {
            return searchReplies
          }
        }
      }
    }
    return 0
  }

  console.log("New comment", req.body)
  const userId = req.header('Authorization');
  const user = (await User.findOne({ _id: userId }))

  const commentCreationTime = new Date()
  const commentId = mongoose.Types.ObjectId()
  const commentContent = req.body.content

  if (!user || !commentContent) {
    return res.status(403).send(sendError(403, 'Comment content empty or user not found'))
  }

  const parsedPayload = parseText(commentContent)
  const inlineElements = {
    type: 'image(s)',
    images: req.body.images,
    position: parsedPayload.array.length // At the end of the comment
  }

  console.log(parsedPayload)

  const comment = {
    _id: commentId,
    authorEmail: user.email,
    author: user._id,
    timestamp: commentCreationTime,
    rawContent: commentContent,
    parsedContent: parsedPayload.text,
    cachedHtml: { fullContentHtml: parsedPayload.text },
    mentions: parsedPayload.mentions,
    tags: parsedPayload.tags,
    inlineElements: req.body.images ? inlineElements : undefined
  }

  Post.findOne({ _id: req.params.postid })
    .populate('author')
    .then(async (post) => {
      console.log("Post", post._id)
      let postType
      let postPrivacy
      if (post.communityId) {
        postType = 'community'
        postPrivacy = (await Community.findById(post.communityId)).settings.visibility
      } else {
        postType = 'original'
        postPrivacy = post.privacy
      }
      let depth
      let commentParent
      if (!req.params.commentid) {
        depth = 1
        commentParent = undefined
        // This is a top level comment with no parent (identified by commentid)
        post.comments.push(comment)
      } else {
        // This is a child level comment so we have to drill through the comments
        // until we find it
        ({ commentParent, depth } = findCommentByID(req.params.commentid, post.comments))
        if (!commentParent) {
          console.log('Parent comment not found', req.params.commentid)
          return res.status(403).send(sendError(403, 'Parent comment not found'))
        } else if (depth > 5) {
          console.log('Comment too deep', depth)
          return res.status(403).send(sendError(403, 'Comment too deep'))
        }
        commentParent.replies.push(comment)
      }

      post.numberOfComments = countComments(post.comments)
      post.lastUpdated = new Date()
      // We reset the cache time of the post to force the comments to reload on the web version
      post.cachedHTML.imageGalleryMTime = null
      post.cachedHTML.embedsMTime = null

      // Add user to subscribed users for post
      if ((!post.author._id.equals(user._id) && !post.subscribedUsers.includes(user._id.toString()))) { // Don't subscribe to your own post, or to a post you're already subscribed to
        post.subscribedUsers.push(user._id.toString())
      }

      if (req.body.images) {
        req.body.images.forEach(async (filename) => {
          const image = new Image({
            context: post.communityId ? 'community' : 'user',
            filename: 'images/' + filename,
            url: 'https://sweet-images.s3.eu-west-2.amazonaws.com/images/' + filename,
            privacy: postPrivacy,
            user: user._id,
            // quality: postImageQuality,
            // height: metadata.height,
            // width: metadata.width
          })
          await image.save()
        })
      }

      post.save()
        .then(async () => {
          // Notification code would go here
          return res.status(200).send(sendResponse(post, 200))
        })
    })
    .catch((error) => {
      console.error(error)
      return res.status(500).send(sendError(500, 'Error saving comment'))
    })
})

app.get('/api/communities/all', (req, res) => {
  Community.find({})
  .sort('name')
  .then(communities => {
    if (!communities.length) {
      return res.status(404).send(sendError(400, 'No communities found!'))
    } else {
      return res.status(200).send(sendResponse(communities, 200))
    }
  })
  .catch((error) => {
    console.error(error)
    return res.status(500).send(sendError(403, 'Error fetching communities'))
  })
})

app.post('/api/community/join', async (req, res) => {
  const userId = req.header('Authorization');
  const user = (await User.findOne({ _id: userId }))
  const community = await Community.findOne({ _id: req.body.communityId })
  if (!community || !user) {
    return res.status(403).send(sendError(403, 'Community or user not found'))
  }
  if (community.bannedMembers.includes(req.user._id)) {
    return res.status(403).send(sendError(403, 'Community or user not found'))
  }
  if (community.members.some(v => v.equals(req.user._id)) || user.communities.some(v => v.toString() === req.body.communityId)) {
    return res.status(406).send(sendError(406, 'User already member of community'))
  }
  community.members.push(user._id)
  await community.save()
  touchCommunity(req.body.communityId)
  user.communities.push(req.params.communityId)
  await user.save()
  return res.sendStatus(200)
})

app.post('/api/community/leave', async (req, res) => {
  const userId = req.header('Authorization');
  const user = (await User.findOne({ _id: userId }))
  const community = await Community.findOne({ _id: req.body.communityId })
  if (!community || !user) {
    return res.status(403).send(sendError(403, 'Community or user not found'))
  }
  community.members.pull(req.user._id)
  await community.save()
  user.communities.pull(req.body.communityId)
  await user.save()
  return res.sendStatus(200)
})


app.listen(port)

console.log('Server booting on default port: ' + port)